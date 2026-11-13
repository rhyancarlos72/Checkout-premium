import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { HttpError, logger, must, onlyDigits, productCode, supabase } from '../lib/core.js';
import { pixQrDataUrl } from '../lib/qr.js';
import { runAsOrg } from '../lib/tenant.js';
import { efi } from '../providers/index.js';
import type { CreatedCharge } from '../providers/types.js';
import { sendSubscriptionEmail } from './email.js';
import { feeFieldsFor } from './fees.js';
import { pixAutoConfig, pixExpiresMinutes } from './gateways.js';
import { emitInvoice } from './invoices.js';
import { recordSale } from './ledger.js';
import { sendWhatsAppText } from './whatsapp.js';

/**
 * Assinatura mensal por Pix Automático (só nos order bumps marcados no painel, só vendas da Prime).
 *
 * 1ª compra: UM QR Code paga o pedido e autoriza a mensalidade no app do banco (Jornada 3 da Efí).
 * Pago → acesso por 1 mês. Antes de vencer (10 a 2 dias, regra do Pix Automático) o sistema agenda a
 * cobrança do mês na autorização; quando a Efí confirma, gera a venda de renovação e estende o acesso.
 * Sem autorização (recusada, cancelada no banco, Pix Automático indisponível) ou débito recusado:
 * o cliente recebe por e-mail/WhatsApp um link de renovação (Pix na hora, que também pede a autorização).
 * Venceu: 3 dias de tolerância com o acesso liberado; depois o curso fica bloqueado até pagar.
 */
export const GRACE_DAYS = 3;
const DAY = 86_400_000;

export type SubLine = { kind: string; name: string; price_cents: number; product_id?: string | null; bump_id?: string | null; recurring?: boolean; monthly_cents?: number };

// ------------------------------------------------------------------ datas (calendário de São Paulo)
export function spDate(d: Date | number) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export function addMonths(d: Date | number, n: number) {
  const x = new Date(d);
  const day = x.getUTCDate();
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + n);
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, last)); // 31/01 + 1 mês = 28 ou 29/02
  return x;
}

/** Order bump é assinatura quando o PRODUTO oferecido está marcado como assinatura (aba Produtos) — ou o próprio bump. */
export const bumpIsRecurring = (b: any) => Boolean(b?.recurring || b?.product?.recurring);
/** Valor de cada mês: o do produto, senão o do bump, senão o preço da oferta. */
export const bumpMonthlyCents = (b: any): number => b?.product?.recurring_price_cents ?? b?.recurring_price_cents ?? b?.price_cents;

export const recurringLines = <T extends SubLine>(lines: T[]) => lines.filter((l) => l.recurring);
export const monthlyCentsOf = (lines: SubLine[]) => recurringLines(lines).reduce((s, l) => s + (l.monthly_cents ?? l.price_cents), 0);
const namesOf = (items: { name: string }[]) => items.map((i) => i.name).join(' + ');

/** Assinaturas valem só nas vendas da Prime, com a Efí Pix configurada e o Pix Automático ligado em Integrações. */
export function subscriptionsAvailable(ownerSale: boolean) {
  return ownerSale && pixAutoConfig().enabled;
}

/** Link de renovação assinado (e-mail, WhatsApp, área de membros): abre o Pix da mensalidade na hora. */
const renewSig = (subId: string) => crypto.createHmac('sha256', env.SUPABASE_SERVICE_ROLE_KEY).update(`renew:${subId}`).digest('hex').slice(0, 24);
export const renewUrl = (subId: string) => `${env.PUBLIC_URL}/assinatura/${subId}?s=${renewSig(subId)}`;
export const validRenewSig = (subId: string, sig: string) => {
  const good = renewSig(subId);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
};

// ------------------------------------------------------------------ cobrança com autorização (Jornada 3)
/** Pix que paga agora + autoriza a mensalidade. Sem CPF válido não há como autorizar (regra do Banco Central). */
export async function issueAutoCharge(p: {
  orderId: string;
  orderNumber: number;
  totalCents: number;
  description: string;
  customer: { name: string; email: string; phone?: string | null; document?: string | null };
  monthlyCents: number;
  items: { name: string }[];
  firstDue: Date;
}): Promise<CreatedCharge & { recId: string | null; recError?: string }> {
  return efi.createAutoCharge({
    orderId: p.orderId,
    amountCents: p.totalCents,
    description: p.description,
    expiresInSeconds: pixExpiresMinutes() * 60,
    customer: p.customer,
    rec: {
      cpf: onlyDigits(p.customer.document),
      name: p.customer.name,
      monthlyCents: p.monthlyCents,
      contract: `PEDIDO ${productCode(p.orderNumber)}`,
      object: `Assinatura ${namesOf(p.items)}`,
      firstDue: spDate(p.firstDue),
    },
  });
}

/** Cria a assinatura (pendente) do pedido e liga os dois. Sem a tabela (SQL não rodado): não faz nada. */
export async function createSubscriptionForOrder(p: { orderId: string; orgId: string | null; customerId: string; lines: SubLine[]; recId: string | null }) {
  const subLines = recurringLines(p.lines);
  if (!subLines.length) return null;
  const items = subLines.map((l) => ({ product_id: l.product_id ?? null, bump_id: l.bump_id ?? null, name: l.name, price_cents: l.monthly_cents ?? l.price_cents }));
  const { data, error } = await supabase
    .from('subscriptions')
    .insert({
      org_id: p.orgId,
      customer_id: p.customerId,
      origin_order_id: p.orderId,
      status: 'pending',
      price_cents: monthlyCentsOf(p.lines),
      product_ids: items.map((i) => i.product_id).filter(Boolean),
      items,
      rec_id: p.recId,
      rec_status: p.recId ? 'CRIADA' : null,
    })
    .select('id')
    .single();
  if (error || !data) {
    logger.error({ err: error?.message, orderId: p.orderId }, 'Assinatura não registrada');
    return null;
  }
  await supabase.from('orders').update({ subscription_id: (data as any).id, ...(p.recId ? { rec_id: p.recId } : {}) }).eq('id', p.orderId);
  return (data as any).id as string;
}

// ------------------------------------------------------------------ pagamento confirmado
/** Pedido pago (1ª compra ou renovação): libera/estende o acesso por 1 mês. Idempotente por pedido. */
export async function onOrderPaid(orderId: string) {
  const { data: o } = await supabase.from('orders').select('id, subscription_id, kind, paid_at').eq('id', orderId).maybeSingle();
  const order: any = o;
  if (!order?.subscription_id) return;
  const { data: s } = await supabase.from('subscriptions').select('*').eq('id', order.subscription_id).maybeSingle();
  const sub: any = s;
  if (!sub) return;
  if (sub.notices?.paid_order === orderId) return; // este pagamento já estendeu
  const now = Date.now();
  const until = sub.paid_until ? new Date(sub.paid_until).getTime() : 0;
  // renovou em dia (ou na tolerância): conta a partir do vencimento, mantendo o mesmo dia do mês
  const base = until && until + GRACE_DAYS * DAY > now ? until : new Date(order.paid_at ?? now).getTime();
  const next = addMonths(base, 1);
  await supabase
    .from('subscriptions')
    .update({
      status: sub.status === 'canceled' ? 'canceled' : 'active',
      paid_until: next.toISOString(),
      next_due: spDate(next),
      cobr_txid: null,
      cobr_status: null,
      renewal_order_id: null,
      notices: { paid_order: orderId },
      updated_at: new Date().toISOString(),
    })
    .eq('id', sub.id);
}

/** Renovação paga pelo link (Pix): avisa o cliente (sem PayTracking/WhatsApp de venda: não é venda de anúncio). */
export async function onRenewalPaid(orderId: string) {
  const { data } = await supabase.from('orders').select('subscription_id, total_cents, customer:customers(name, email)').eq('id', orderId).maybeSingle();
  const o: any = data;
  if (!o?.subscription_id || !o.customer?.email) return;
  const { data: s } = await supabase.from('subscriptions').select('items, paid_until').eq('id', o.subscription_id).maybeSingle();
  const until = (s as any)?.paid_until ? new Date((s as any).paid_until).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : null;
  await sendSubscriptionEmail({
    to: o.customer.email,
    name: o.customer.name ?? '',
    orderId,
    event: 'subscription_paid',
    subject: 'Mensalidade confirmada: seu acesso continua liberado',
    title: 'Sua mensalidade foi confirmada',
    paragraphs: [`Recebemos o pagamento de ${namesOf((s as any)?.items ?? [])}.`, until ? `Seu acesso está garantido até ${until}.` : 'Seu acesso continua liberado.'],
    cta: { label: 'Entrar na área de membros', url: `${env.PUBLIC_URL}/membros` },
  }).catch(() => {});
}

// ------------------------------------------------------------------ autorização e cobranças (Efí)
const REC_FINAL = new Set(['APROVADA', 'REJEITADA', 'EXPIRADA', 'CANCELADA']);
const COBR_FINAL = new Set(['CONCLUIDA', 'REJEITADA', 'EXPIRADA', 'CANCELADA']);

/** Atualiza a autorização pelo que a EFÍ responde (nunca pelo corpo do aviso). */
export async function syncRec(idRec: string) {
  const r = await efi.getRec(idRec);
  const status = String(r?.status ?? '').toUpperCase();
  if (!status) return null;
  await supabase.from('subscriptions').update({ rec_status: status, updated_at: new Date().toISOString() }).eq('rec_id', idRec);
  return status;
}

/** Cobrança do mês: CONCLUIDA gera a venda de renovação; recusada/expirada cai no link de renovação. */
export async function syncCobr(txid: string) {
  const c = await efi.getCobr(txid);
  const status = String(c?.status ?? '').toUpperCase();
  if (!status) return null;
  const { data } = await supabase.from('subscriptions').select('*').eq('cobr_txid', txid).maybeSingle();
  const sub: any = data;
  if (!sub) return status;
  await supabase.from('subscriptions').update({ cobr_status: status, updated_at: new Date().toISOString() }).eq('id', sub.id);
  if (status === 'CONCLUIDA') await confirmAutoRenewal(sub, txid, Math.round(Number(c?.valor?.original ?? 0) * 100) || sub.price_cents);
  return status;
}

/** Débito automático confirmado: registra a venda de renovação (financeiro, nota) e estende o acesso. */
async function confirmAutoRenewal(sub: any, txid: string, amountCents: number) {
  const { data: exists } = await supabase.from('orders').select('id').eq('provider', 'efi').eq('provider_charge_id', txid).maybeSingle();
  if (exists) return;
  const { data: origin } = await supabase.from('orders').select('checkout_id, tracking').eq('id', sub.origin_order_id).maybeSingle();
  await runAsOrg(sub.org_id ?? null, async () => {
    const lines = (sub.items as any[]).map((i) => ({ kind: 'main', name: i.name, price_cents: i.price_cents, product_id: i.product_id, recurring: true }));
    const order = must(
      await supabase
        .from('orders')
        .insert({
          checkout_id: (origin as any)?.checkout_id ?? null,
          customer_id: sub.customer_id,
          provider: 'efi',
          provider_charge_id: txid,
          kind: 'renewal',
          subscription_id: sub.id,
          rec_id: sub.rec_id,
          subtotal_cents: amountCents,
          discount_cents: 0,
          total_cents: amountCents,
          tracking: { renewal_of: sub.origin_order_id, auto: 'pix_automatico' },
          recovery_sent_at: new Date().toISOString(),
          ...(await feeFieldsFor(sub.org_id ?? null, lines as any, amountCents)),
        })
        .select('id')
        .single(),
    ) as { id: string };
    await supabase.from('order_items').insert(lines.map((l) => ({ ...l, order_id: order.id })));
    const { data: ok } = await supabase.rpc('mark_order_paid', { p_order_id: order.id });
    if (!ok) return;
    await Promise.allSettled([recordSale(order.id), emitInvoice(order.id), onOrderPaid(order.id)]);
    await onRenewalPaid(order.id);
  });
}

/** Agenda a cobrança do mês na autorização aprovada (de 10 a 2 dias antes do vencimento). */
async function scheduleCobr(sub: any, now: number) {
  const due = new Date(Math.max(new Date(sub.paid_until).getTime(), now + 2 * DAY + 3_600_000));
  const dueDate = spDate(due);
  const txid = `${sub.id.replace(/-/g, '').slice(0, 26)}${dueDate.replace(/-/g, '').slice(2)}`; // 32 caracteres, um por mês
  try {
    await efi.createCobr({ txid, idRec: sub.rec_id, dueDate, amountCents: sub.price_cents, info: `Assinatura ${namesOf(sub.items ?? [])}`, account: pixAutoConfig().account });
    await supabase.from('subscriptions').update({ cobr_txid: txid, cobr_status: 'CRIADA', updated_at: new Date().toISOString() }).eq('id', sub.id);
  } catch (e: any) {
    logger.warn({ err: e?.message, sub: sub.id }, 'Cobrança do Pix Automático não agendada: o cliente recebe o link de renovação');
    await supabase.from('subscriptions').update({ cobr_status: 'FALHOU', notices: { ...(sub.notices ?? {}), cobr_error: String(e?.message ?? e).slice(0, 200) }, updated_at: new Date().toISOString() }).eq('id', sub.id);
  }
}

// ------------------------------------------------------------------ renovação pelo link
/** Abre (ou reaproveita) o Pix de renovação da assinatura. Também pede a autorização do Pix Automático. */
export async function renewalOrderFor(subId: string): Promise<string> {
  const { data } = await supabase.from('subscriptions').select('*, customer:customers(name, email, phone, document)').eq('id', subId).maybeSingle();
  const sub: any = data;
  if (!sub) throw new HttpError(404, 'Assinatura não encontrada');
  if (sub.status === 'canceled') throw new HttpError(400, 'Esta assinatura foi cancelada. Faça uma nova compra pelo checkout.');
  if (sub.renewal_order_id) {
    const { data: prev } = await supabase.from('orders').select('public_token, status, expires_at').eq('id', sub.renewal_order_id).maybeSingle();
    const p: any = prev;
    if (p && (p.status === 'paid' || (p.status === 'pending' && p.expires_at && new Date(p.expires_at).getTime() > Date.now() + 5 * 60_000))) return p.public_token;
  }
  const { data: origin } = await supabase.from('orders').select('checkout_id, tracking').eq('id', sub.origin_order_id).maybeSingle();
  return runAsOrg(sub.org_id ?? null, async () => {
    const lines = (sub.items as any[]).map((i) => ({ kind: 'main', name: i.name, price_cents: i.price_cents, product_id: i.product_id, recurring: true }));
    const order = must(
      await supabase
        .from('orders')
        .insert({
          checkout_id: (origin as any)?.checkout_id ?? null,
          customer_id: sub.customer_id,
          provider: 'efi',
          kind: 'renewal',
          subscription_id: sub.id,
          subtotal_cents: sub.price_cents,
          discount_cents: 0,
          total_cents: sub.price_cents,
          tracking: { renewal_of: sub.origin_order_id },
          recovery_sent_at: new Date().toISOString(), // lembretes da renovação são os da assinatura
          ...(await feeFieldsFor(sub.org_id ?? null, lines as any, sub.price_cents)),
        })
        .select('id, number, public_token')
        .single(),
    ) as { id: string; number: number; public_token: string };
    await supabase.from('order_items').insert(lines.map((l) => ({ ...l, order_id: order.id })));
    const c = sub.customer ?? {};
    // autorização ainda válida: só o Pix do mês; sem autorização: o mesmo QR já pede a autorização de novo
    const needsAuth = sub.rec_status !== 'APROVADA' && onlyDigits(c.document).length >= 11;
    const base = sub.paid_until && new Date(sub.paid_until).getTime() + GRACE_DAYS * DAY > Date.now() ? new Date(sub.paid_until) : new Date();
    const charge = needsAuth
      ? await issueAutoCharge({ orderId: order.id, orderNumber: order.number, totalCents: sub.price_cents, description: `Mensalidade #${order.number} - ${namesOf(sub.items)}`, customer: c, monthlyCents: sub.price_cents, items: sub.items, firstDue: addMonths(base, 1) })
      : { ...(await efi.createCharge({ orderId: order.id, amountCents: sub.price_cents, description: `Mensalidade #${order.number} - ${namesOf(sub.items)}`, expiresInSeconds: pixExpiresMinutes() * 60, customer: c })), recId: null };
    const qr = (await pixQrDataUrl(charge.pixCode)) ?? charge.qrImage;
    await Promise.all([
      supabase.from('orders').update({ provider_charge_id: charge.chargeId, pix_code: charge.pixCode, pix_qr_image: qr, expires_at: charge.expiresAt.toISOString(), ...(charge.recId ? { rec_id: charge.recId } : {}) }).eq('id', order.id),
      supabase.from('subscriptions').update({ renewal_order_id: order.id, ...(charge.recId ? { rec_id: charge.recId, rec_status: 'CRIADA' } : {}), updated_at: new Date().toISOString() }).eq('id', sub.id),
    ]);
    return order.public_token;
  });
}

// ------------------------------------------------------------------ avisos ao cliente
async function notify(sub: any, key: string, msg: { subject: string; title: string; paragraphs: string[]; whatsapp: string }) {
  if (sub.notices?.[key]) return;
  const notices = { ...(sub.notices ?? {}), [key]: new Date().toISOString() };
  sub.notices = notices;
  await supabase.from('subscriptions').update({ notices }).eq('id', sub.id);
  const { data: c } = await supabase.from('customers').select('name, email, phone').eq('id', sub.customer_id).maybeSingle();
  const cust: any = c;
  if (!cust) return;
  const link = renewUrl(sub.id);
  await Promise.allSettled([
    cust.email ? sendSubscriptionEmail({ to: cust.email, name: cust.name ?? '', orderId: sub.origin_order_id, event: `subscription_${key}`, subject: msg.subject, title: msg.title, paragraphs: msg.paragraphs, cta: { label: 'Renovar pelo Pix', url: link } }) : null,
    // WhatsApp da Prime (assinaturas só existem em vendas da Prime)
    cust.phone ? sendWhatsAppText(cust.phone, `${msg.whatsapp}\n\n👉 Renovar pelo Pix: ${link}`) : null,
  ]);
}

// ------------------------------------------------------------------ rotina (a cada 2 minutos, junto dos outros jobs)
export async function runSubscriptionJobs(now = Date.now()) {
  const { data, error } = await supabase.from('subscriptions').select('*').in('status', ['active', 'past_due', 'pending']).limit(500);
  if (error) return; // banco sem a migração das assinaturas
  const subs = (data ?? []) as any[];
  let calls = 0; // limite de consultas à Efí por rodada
  for (const sub of subs) {
    try {
      // autorização pendente: confere na Efí (o aviso pode ter se perdido)
      if (sub.rec_id && (!sub.rec_status || !REC_FINAL.has(sub.rec_status)) && calls < 20 && now - new Date(sub.updated_at).getTime() > 5 * 60_000) {
        calls++;
        sub.rec_status = (await syncRec(sub.rec_id).catch(() => null)) ?? sub.rec_status;
      }
      if (sub.status === 'pending' || !sub.paid_until) continue;
      const until = new Date(sub.paid_until).getTime();
      const first = (sub.items?.[0]?.name as string) ?? 'sua assinatura';
      const dateBR = new Date(until).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

      // cobrança do mês em andamento: confere na Efí
      if (sub.cobr_txid && !COBR_FINAL.has(sub.cobr_status ?? '') && calls < 20) {
        calls++;
        sub.cobr_status = (await syncCobr(sub.cobr_txid).catch(() => null)) ?? sub.cobr_status;
        if (sub.cobr_status === 'CONCLUIDA') continue;
      }
      // autorização aprovada: agenda o débito do mês (até 10 dias antes)
      if (sub.rec_status === 'APROVADA' && !sub.cobr_txid && !sub.canceled_at && until - now <= 10 * DAY && until + GRACE_DAYS * DAY > now) {
        if (!sub.notices?.cobr_error || now - new Date(sub.updated_at).getTime() > DAY) await scheduleCobr(sub, now);
        continue;
      }
      const auto = sub.rec_status === 'APROVADA' && sub.cobr_txid && !['REJEITADA', 'EXPIRADA', 'CANCELADA', 'FALHOU'].includes(sub.cobr_status ?? '');
      // sem débito automático: link de renovação 3 dias antes de vencer
      if (!auto && until - now <= 3 * DAY && until > now) {
        await notify(sub, `renew_${spDate(until)}`, {
          subject: `Sua assinatura de ${first} vence em ${dateBR}`,
          title: 'Sua assinatura vence em breve',
          paragraphs: [`Seu acesso a ${namesOf(sub.items ?? [])} vai até ${dateBR}.`, 'Renove pelo Pix em 1 minuto e, se quiser, autorize o Pix Automático no app do banco para não precisar renovar todo mês.'],
          whatsapp: `Oi! Sua assinatura de *${first}* vence em ${dateBR}. Renove pelo Pix para continuar com o acesso.`,
        });
      }
      // venceu: 3 dias de tolerância com acesso, depois bloqueia
      if (until <= now && sub.status === 'active') {
        await supabase.from('subscriptions').update({ status: 'past_due', updated_at: new Date().toISOString() }).eq('id', sub.id);
        if (!auto)
          await notify(sub, `due_${spDate(until)}`, {
            subject: `Sua assinatura de ${first} venceu: renove para não perder o acesso`,
            title: 'Sua assinatura venceu',
            paragraphs: [`Seu acesso a ${namesOf(sub.items ?? [])} continua liberado por mais ${GRACE_DAYS} dias.`, 'Renove pelo Pix para não perder o acesso.'],
            whatsapp: `Sua assinatura de *${first}* venceu. O acesso continua por mais ${GRACE_DAYS} dias: renove pelo Pix para não perder.`,
          });
      }
      if (until + GRACE_DAYS * DAY <= now && sub.status !== 'expired') {
        await supabase.from('subscriptions').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('id', sub.id);
        await notify(sub, `expired_${spDate(until)}`, {
          subject: `Seu acesso a ${first} foi pausado`,
          title: 'Seu acesso foi pausado',
          paragraphs: [`A mensalidade de ${namesOf(sub.items ?? [])} não foi paga e o acesso foi pausado.`, 'Renove pelo Pix e o acesso volta na hora.'],
          whatsapp: `Seu acesso a *${first}* foi pausado porque a mensalidade não foi paga. Renove pelo Pix e ele volta na hora.`,
        });
      }
    } catch (e: any) {
      logger.warn({ err: e?.message, sub: sub.id }, 'Rotina da assinatura falhou (tenta de novo na próxima rodada)');
    }
  }
}

// ------------------------------------------------------------------ cancelamento
/** Cancela a assinatura: para os débitos (autorização cancelada na Efí); o acesso segue até o fim do mês pago. */
export async function cancelSubscription(subId: string) {
  const { data } = await supabase.from('subscriptions').select('id, rec_id, rec_status, status').eq('id', subId).maybeSingle();
  const sub: any = data;
  if (!sub) throw new HttpError(404, 'Assinatura não encontrada');
  if (sub.status === 'canceled') return;
  if (sub.rec_id && ['CRIADA', 'APROVADA'].includes(sub.rec_status ?? '')) await efi.cancelRec(sub.rec_id).catch((e) => logger.warn({ err: e?.message }, 'Efí não cancelou a autorização'));
  await supabase.from('subscriptions').update({ status: 'canceled', canceled_at: new Date().toISOString(), rec_status: sub.rec_id ? 'CANCELADA' : sub.rec_status, updated_at: new Date().toISOString() }).eq('id', subId);
}

// ------------------------------------------------------------------ acesso na área de membros
/** Produtos de assinatura do cliente: liberados (em dia ou na tolerância) e pausados (com link de renovação). */
export async function subscriptionAccess(customerId: string, now = Date.now()) {
  const { data, error } = await supabase.from('subscriptions').select('id, status, paid_until, product_ids').eq('customer_id', customerId);
  const active = new Set<string>();
  const paused = new Map<string, string>(); // produto → link de renovação
  if (error) return { active, paused };
  for (const s of (data ?? []) as any[]) {
    if (!s.paid_until) continue;
    const until = new Date(s.paid_until).getTime();
    const ok = s.status === 'canceled' ? until > now : until + GRACE_DAYS * DAY > now;
    for (const pid of s.product_ids ?? []) {
      if (ok) active.add(pid);
      else if (s.status !== 'canceled') paused.set(pid, renewUrl(s.id));
    }
  }
  for (const pid of active) paused.delete(pid);
  return { active, paused };
}
