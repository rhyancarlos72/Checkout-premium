import { env } from '../config/env.js';
import { logger, supabase } from '../lib/core.js';
import { sendRecoveryEmail } from './email.js';
import { sendWhatsAppRecoveries } from './whatsapp.js';
import { notifyPixExpired, syncOrderWithProvider } from './orders.js';
import { getSettings } from './settings.js';

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
    .eq('status', 'pending')
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
  const s = await getSettings();
  if (!s.recovery.enabled) return;
  const olderThan = new Date(Date.now() - s.recovery.delayMinutes * 60 * 1000).toISOString();
  const notBefore = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('orders')
    .select('id, public_token, total_cents, customer_id, customer:customers(name, email), checkout:checkouts(slug, theme), items:order_items(kind, name)')
    .in('status', ['pending', 'expired'])
    .is('recovery_sent_at', null)
    .lt('created_at', olderThan)
    .gt('created_at', notBefore)
    .limit(20);

  for (const o of (data ?? []) as any[]) {
    // marca antes para nunca enviar duas vezes
    const { data: claimed } = await supabase
      .from('orders')
      .update({ recovery_sent_at: new Date().toISOString() })
      .eq('id', o.id)
      .is('recovery_sent_at', null)
      .select('id');
    if (!claimed?.length || !o.customer || !o.checkout) continue;

    // não incomoda quem já comprou depois
    const { count } = await supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', o.customer_id)
      .eq('status', 'paid')
      .gt('created_at', new Date(Date.now() - 48 * 3600 * 1000).toISOString());
    if ((count ?? 0) > 0) continue;

    const main = o.items.find((i: any) => i.kind === 'main');
    await sendRecoveryEmail({
      orderId: o.id,
      to: o.customer.email,
      name: o.customer.name,
      productName: main?.name ?? 'seu produto',
      totalCents: o.total_cents,
      url: `${env.PUBLIC_URL}/checkout?produto_id=${o.checkout.slug}&recover=${o.public_token}&utm_source=recovery&utm_medium=email`,
      accent: o.checkout.theme?.primaryColor,
    });
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
  } catch (e) {
    logger.error({ err: e }, 'Jobs falharam');
  } finally {
    running = false;
  }
}

export function startJobs() {
  // roda uma vez ao iniciar, mesmo com os jobs desligados
  setTimeout(() => void restoreExpiredToPending().catch(() => {}), 5_000).unref();
  if (!env.JOBS_ENABLED || env.NODE_ENV === 'test') return;
  setInterval(runJobs, 2 * 60 * 1000).unref();
  setTimeout(runJobs, 15_000).unref();
  logger.info('Jobs de conciliação/recuperação ativos (a cada 2 min)');
}
