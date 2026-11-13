import { env } from '../config/env.js';
import { logger, sleep, supabase } from '../lib/core.js';
import { RECOVERY_ORDER_SELECT, sendRecoveryForOrder } from './email.js';
import { sendWhatsAppRecoveries } from './whatsapp.js';
import { fulfill, notifyPixExpired, retryFailedTracking, syncOrderWithProvider } from './orders.js';
import { runSubscriptionJobs } from './subscriptions.js';
import { getSettings } from './settings.js';
import { orgOfOrder, runAsOrg } from '../lib/tenant.js';
import { refreshPendingInvoices } from './invoices.js';

/**
 * Jobs de manutenção:
 *  1. Conciliação: consulta no gateway pedidos pendentes recentes (caso um webhook se perca).
 *  2. Pix vencido: continua pendente; webhooks recebem sale.canceled uma vez.
 *  3. Recuperação: e-mail para quem gerou o PIX e não pagou.
 */
export async function reconcilePending() {
  const since = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('orders')
    .select('id')
    .in('status', ['pending', 'canceled']) // cancelado = Pix substituído que ainda pode ter sido pago
    .not('provider_charge_id', 'is', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(30);
  for (const o of data ?? []) {
    try {
      await syncOrderWithProvider(o.id);
    } catch (e: any) {
      logger.warn({ orderId: o.id, err: e?.message }, 'Conciliação falhou');
    }
  }
}

/** Pix vencido NÃO sai de pendente (fica em vendas pendentes); só notifica os webhooks uma vez. */
export async function expireOrders() {
  const now = Date.now();
  const { data } = await supabase
    .from('orders')
    .select('id, checkout_id')
    .eq('status', 'pending')
    .lt('expires_at', new Date(now - 2 * 60 * 1000).toISOString())
    .gt('expires_at', new Date(now - 24 * 60 * 60 * 1000).toISOString())
    .limit(100);
  if (!data?.length) return;
  const { data: done } = await supabase.from('events').select('order_id').eq('type', 'pix_expired').in('order_id', data.map((o) => o.id));
  const notified = new Set((done ?? []).map((e: any) => e.order_id));
  for (const o of data) if (!notified.has(o.id)) await notifyPixExpired(o.id, o.checkout_id);
}

/**
 * Pedidos marcados como "expirado" pela versão antiga voltam para pendente
 * (assim aparecem em vendas pendentes e recebem recuperação), sem precisar rodar SQL.
 */
export async function restoreExpiredToPending() {
  const { data } = await supabase.from('orders').update({ status: 'pending' }).eq('status', 'expired').select('id, checkout_id');
  if (!data?.length) return;
  await supabase.from('events').insert(data.map((o) => ({ order_id: o.id, checkout_id: o.checkout_id, type: 'pix_expired', data: {} })));
  logger.info({ count: data.length }, 'Pedidos expirados voltaram para pendente');
}

export async function sendRecoveries() {
  // cada produtor liga/desliga e define o tempo da própria recuperação; aqui busca a partir do mínimo (5 min)
  const olderThan = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const notBefore = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('orders')
    .select(RECOVERY_ORDER_SELECT)
    .in('status', ['pending', 'expired'])
    .is('recovery_sent_at', null)
    .lt('created_at', olderThan)
    .gt('created_at', notBefore)
    .limit(20);

  // várias cobranças pendentes da mesma pessoa: um único e-mail, da mais recente
  const latestByCustomer = new Map<string, any>();
  for (const o of (data ?? []) as any[]) if (!latestByCustomer.has(o.customer_id) || latestByCustomer.get(o.customer_id).created_at < o.created_at) latestByCustomer.set(o.customer_id, o);
  for (const o of [...latestByCustomer.values()]) {
    const orgId = await orgOfOrder(o.id);
    const s = await runAsOrg(orgId, () => getSettings());
    if (!s.recovery.enabled || Date.now() - new Date(o.created_at).getTime() < s.recovery.delayMinutes * 60_000) continue;
    // marca antes para nunca enviar duas vezes
    const { data: claimed } = await supabase
      .from('orders')
      .update({ recovery_sent_at: new Date().toISOString() })
      .eq('id', o.id)
      .is('recovery_sent_at', null)
      .select('id');
    if (!claimed?.length || !o.customer || !o.checkout) continue;
    // as outras cobranças pendentes desta pessoa contam como já lembradas (um e-mail por cliente)
    await supabase.from('orders').update({ recovery_sent_at: new Date().toISOString() }).eq('customer_id', o.customer_id).eq('status', 'pending').is('recovery_sent_at', null);

    // não incomoda quem já comprou depois
    const { count } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', o.customer_id)
      .eq('status', 'paid')
      .gt('created_at', new Date(Date.now() - 48 * 3600 * 1000).toISOString());
    if ((count ?? 0) > 0) continue;

    await runAsOrg(orgId, () => sendRecoveryForOrder(o)); // e-mail com o nome da loja do produtor
    await sleep(1500); // envio espaçado: rajadas de e-mails idênticos pesam contra a reputação
  }
}

/**
 * Venda paga sem e-mail de entrega (SMTP fora do ar na hora): tenta de novo, até 3 vezes no total,
 * espaçado (a rotina roda a cada 2 min; só reenvia 10 min após a última tentativa).
 */
export async function retryDeliveries() {
  const now = Date.now();
  const { data } = await supabase
    .from('orders')
    .select('id')
    .eq('status', 'paid')
    .is('delivered_at', null)
    .lt('paid_at', new Date(now - 3 * 60_000).toISOString())
    .gt('paid_at', new Date(now - 24 * 3600_000).toISOString())
    .limit(10);
  for (const o of data ?? []) {
    const { data: logs } = await supabase.from('integration_logs').select('created_at').eq('integration', 'email').eq('order_id', o.id).eq('event', 'delivery');
    const tries = (logs ?? []) as { created_at: string }[];
    if (tries.length >= 3) continue;
    const last = Math.max(0, ...tries.map((l) => new Date(l.created_at).getTime() || 0));
    if (last && now - last < 10 * 60_000) continue;
    await fulfill(o.id).catch((e) => logger.warn({ orderId: o.id, err: e?.message }, 'Reenvio da entrega falhou'));
  }
}

let running = false;
/** Momento da última execução dos jobs (exibido no diagnóstico do WhatsApp). */
export let lastJobRunAt: number | null = null;
export async function runJobs() {
  if (running) return;
  running = true;
  lastJobRunAt = Date.now();
  try {
    await restoreExpiredToPending();
    await reconcilePending();
    await expireOrders();
    await sendRecoveries();
    await sendWhatsAppRecoveries();
    await retryDeliveries();
    await retryFailedTracking().catch((e) => logger.warn({ err: (e as Error)?.message }, 'Reenvio de eventos falhou'));
    await runSubscriptionJobs().catch((e) => logger.warn({ err: (e as Error)?.message }, 'Rotina das assinaturas falhou'));
    await refreshPendingInvoices();
  } catch (e) {
    logger.error({ err: e }, 'Jobs falharam');
  } finally {
    running = false;
  }
}

/** Ao ligar o servidor: deixa em memória o que toda visita ao checkout usa (a 1ª visita não espera o banco). */
export async function warmCaches() {
  try {
    (await import('./geoip.js')).warmGeoDb(); // base de cidade/estado por IP (~4 MB) em memória antes da 1ª visita
    const { ownerOrgId } = await import('../lib/tenant.js');
    await ownerOrgId();
    await getSettings();
    const { loadCheckout } = await import('./orders.js');
    const { data } = await supabase.from('checkouts').select('slug').eq('active', true).order('updated_at', { ascending: false }).limit(30);
    await Promise.allSettled(((data ?? []) as any[]).map((c) => loadCheckout(c.slug)));
  } catch (e) {
    logger.warn({ err: (e as Error)?.message }, 'Aquecimento do cache falhou (segue normal)');
  }
}

export function startJobs() {
  if (env.NODE_ENV !== 'test') setTimeout(() => void warmCaches(), 1_000).unref();
  // roda uma vez ao iniciar, mesmo com os jobs desligados
  setTimeout(() => void restoreExpiredToPending().catch(() => {}), 5_000).unref();
  if (!env.JOBS_ENABLED || env.NODE_ENV === 'test') return;
  setInterval(runJobs, 2 * 60 * 1000).unref();
  setTimeout(runJobs, 15_000).unref();
  logger.info('Jobs de conciliação/recuperação ativos (a cada 2 min)');
}
