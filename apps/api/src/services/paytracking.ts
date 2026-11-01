import crypto from 'node:crypto';
import { env, features } from '../config/env.js';
import { fetchWithTimeout, logger, sleep, supabase } from '../lib/core.js';

/**
 * PayTracking — porta em TypeScript do `paytracking.php` (v2.0).
 * Mesmo contrato: Bearer token + assinatura HMAC-SHA256 de `${timestamp}.${body}`
 * nos headers X-Paytrack-Timestamp / X-Paytrack-Signature.
 * URL, token e segredo vêm SOMENTE de variáveis de ambiente.
 */

export type PayTrackingEvent = 'sale.pending' | 'sale.approved' | 'sale.refunded' | 'sale.canceled' | 'sale.chargeback';

const STATUS: Record<PayTrackingEvent, string> = {
  'sale.pending': 'pending',
  'sale.approved': 'paid',
  'sale.refunded': 'refunded',
  'sale.canceled': 'canceled',
  'sale.chargeback': 'chargeback',
};

export interface OrderForTracking {
  id: string;
  number: number;
  provider: string;
  total_cents: number;
  created_at: string;
  ip: string | null;
  user_agent: string | null;
  tracking: Record<string, any>;
  checkout_slug: string | null;
  customer: { name: string; email: string; phone: string | null; document: string | null } | null;
  items: { kind: string; name: string; price_cents: number; product_id: string | null; bump_id: string | null }[];
}

function buildPayload(o: OrderForTracking, event: PayTrackingEvent) {
  const t = o.tracking ?? {};
  const status = STATUS[event];
  const eventId =
    event === 'sale.approved'
      ? t.purchase_event_id || `purchase_${o.id}`
      : event === 'sale.pending'
        ? t.initiate_checkout_event_id || t.event_id || null
        : null;

  let fbc = t.fbc ?? null;
  if (!fbc && t.fbclid) fbc = `fb.1.${new Date(o.created_at).getTime()}.${t.fbclid}`;

  const [first, ...rest] = (o.customer?.name ?? '').trim().split(/\s+/);
  const main = o.items.find((i) => i.kind === 'main');
  const value = Number((o.total_cents / 100).toFixed(2));

  return {
    event,
    status,
    payment_status: status,
    payment_method: 'pix',
    gateway: o.provider,
    transaction_id: o.id,
    order_number: o.number,
    value,
    currency: 'BRL',
    event_source_url: t.page_url || (o.checkout_slug ? `${env.PUBLIC_URL}/c/${o.checkout_slug}` : env.PUBLIC_URL),
    product_id: main?.product_id ?? '',
    product_name: main?.name ?? '',
    products: o.items.map((i) => ({
      id: i.product_id ?? i.bump_id ?? '',
      name: i.name,
      quantity: 1,
      price: Number((i.price_cents / 100).toFixed(2)),
    })),
    customer: {
      first_name: first || null,
      last_name: rest.join(' ') || null,
      name: o.customer?.name ?? null,
      email: o.customer?.email ?? null,
      phone: o.customer?.phone ?? null,
      document: o.customer?.document ?? null,
      country: 'BR',
      external_id: t.external_id ?? null,
    },
    tracking: {
      event_id: eventId,
      purchase_event_id: status === 'paid' ? eventId : null,
      external_id: t.external_id ?? null,
      pt_xid: t.external_id ?? null,
      fbp: t.fbp ?? null,
      fbc,
      fbclid: t.fbclid ?? null,
      utm_source: t.utm_source ?? null,
      utm_medium: t.utm_medium ?? null,
      utm_campaign: t.utm_campaign ?? null,
      utm_content: t.utm_content ?? null,
      utm_term: t.utm_term ?? null,
      utm_id: t.utm_id ?? null,
      client_ip_address: o.ip,
      client_user_agent: o.user_agent,
    },
  };
}

export function signPayTracking(body: string, secret: string, ts = Math.floor(Date.now() / 1000).toString()) {
  return { ts, signature: `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}` };
}

async function transmit(payload: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${env.PAYTRACKING_TOKEN}`,
    'User-Agent': 'PayTracking-Node/2.0.0 (+checkout-proprio)',
    ...extraHeaders,
  };
  if (env.PAYTRACKING_SECRET) {
    const { ts, signature } = signPayTracking(body, env.PAYTRACKING_SECRET);
    headers['X-Paytrack-Timestamp'] = ts;
    headers['X-Paytrack-Signature'] = signature;
  }
  const started = Date.now();
  let status = 0;
  let json: any = {};
  let error = '';
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetchWithTimeout(env.PAYTRACKING_URL!, { method: 'POST', headers, body, timeoutMs: 8000, redirect: 'manual' });
      status = res.status;
      json = await res.json().catch(() => ({}));
      error = '';
    } catch (e: any) {
      status = 0;
      error = e?.message ?? 'falha de rede';
    }
    const retryable = status === 0 || status === 429 || status >= 500;
    if (!retryable || i === 3 || Date.now() - started > 9000) break;
    await sleep(250 * 2 ** (i - 1) + Math.random() * 150);
  }
  return { ok: status >= 200 && status < 300, status, json, error };
}

export async function sendPayTracking(order: OrderForTracking, event: PayTrackingEvent): Promise<boolean> {
  if (!features.paytracking) return false;
  try {
    const r = await transmit(buildPayload(order, event));
    const message = r.ok
      ? r.json?.duplicate
        ? 'duplicado (já recebido)'
        : String(r.json?.status ?? 'processado')
      : `${r.error} ${r.json?.error ?? ''} ${r.json?.reason ? `(${r.json.reason})` : ''}`.trim();
    await supabase.from('integration_logs').insert({
      integration: 'paytracking',
      order_id: order.id,
      event,
      ok: r.ok,
      http_status: r.status,
      message: message.slice(0, 500),
    });
    return r.ok;
  } catch (e) {
    logger.error({ err: e, orderId: order.id }, 'PayTracking falhou');
    return false;
  }
}

export async function testPayTracking() {
  if (!features.paytracking) return { ok: false, message: 'PAYTRACKING_URL / PAYTRACKING_TOKEN não configurados' };
  const r = await transmit({ event: 'connection_test', transaction_id: 'teste-de-conexao' }, { 'X-Paytrack-Test': '1' });
  if (r.ok) {
    return {
      ok: true,
      message: `Conexão OK${r.json?.signature === 'valid' ? ', assinatura válida' : ' (sem segredo de assinatura)'}. Nenhum evento foi enviado à Meta.`,
    };
  }
  if (r.status === 401) return { ok: false, message: 'Token ou segredo inválido no PayTracking.' };
  if (r.status === 404) return { ok: false, message: 'URL do PayTracking não encontrada.' };
  if (r.status === 0) return { ok: false, message: `Sem conexão com o PayTracking: ${r.error}` };
  return { ok: false, message: `PayTracking respondeu HTTP ${r.status}` };
}
