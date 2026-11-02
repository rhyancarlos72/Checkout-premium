import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { fetchWithTimeout, logger, phoneE164BR, productCode, sleep, supabase } from '../lib/core.js';
import { allWebhooks, targetsFor } from './webhooks.js';

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
  customer_id?: string | null;
  customer: { name: string; email: string; phone: string | null; document: string | null } | null;
  items: { kind: string; name: string; price_cents: number; product_id: string | null; bump_id: string | null; product?: { number: number | null } | null }[];
}

const code = (i?: { product?: { number: number | null } | null }) => productCode(i?.product?.number ?? null);

export function buildPayload(o: OrderForTracking, event: PayTrackingEvent) {
  const t = o.tracking ?? {};
  const status = STATUS[event];
  const eventId =
    event === 'sale.approved'
      ? t.purchase_event_id || `purchase_${o.id}`
      : event === 'sale.pending'
        ? t.initiate_checkout_event_id || t.event_id || null
        : null;

  let fbc = t.fbc ?? null;
  // sem cookie _fbc: monta pelo fbclid com o horário do clique (ou do pedido, se não houver)
  if (!fbc && t.fbclid) fbc = `fb.1.${Number(t.fbclid_at) || new Date(o.created_at).getTime()}.${t.fbclid}`;
  // external_id estável: o da URL (PayTracking/anúncio) ou o ID do cliente no checkout
  const externalId = t.external_id || t.pt_xid || o.customer_id || null;
  const phone = phoneE164BR(o.customer?.phone);
  const codes = o.items.map(code).filter(Boolean);

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
    event_source_url: t.page_url || (o.checkout_slug ? `${env.PUBLIC_URL}/checkout?produto_id=${o.checkout_slug}` : env.PUBLIC_URL),
    // ID do produto = o mesmo ID de 7 dígitos do painel (ex.: 8939361). É ele que a PayTracking
    // compara com "IDs de produto deste pixel" para saber em qual pixel registrar a venda.
    product_id: code(main) || main?.product_id || '',
    product_code: code(main) || null,
    product_name: main?.name ?? '',
    product_uuid: main?.product_id ?? null,
    product_number: main?.product?.number ?? null, // número interno (#1001)
    product_ids: o.items.map(code).filter(Boolean),
    products: o.items.map((i) => ({
      id: code(i) || i.product_id || i.bump_id || '',
      code: code(i) || null,
      uuid: i.product_id ?? null,
      number: i.product?.number ?? null,
      kind: i.kind,
      name: i.name,
      quantity: 1,
      price: Number((i.price_cents / 100).toFixed(2)),
    })),
    // padrão de e-commerce da Meta (Purchase/InitiateCheckout)
    content_ids: codes,
    content_type: 'product',
    num_items: o.items.length,
    contents: o.items.map((i) => ({ id: code(i) || i.product_id || i.bump_id || '', quantity: 1, item_price: Number((i.price_cents / 100).toFixed(2)) })),
    event_time: Math.floor(Date.now() / 1000),
    created_at: o.created_at,
    customer: {
      first_name: first || null,
      last_name: rest.join(' ') || null,
      name: o.customer?.name ?? null,
      email: o.customer?.email?.trim().toLowerCase() ?? null,
      phone, // com 55 (a Meta exige o código do país)
      phone_raw: o.customer?.phone ?? null,
      document: o.customer?.document ?? null,
      country: (t.geo_country || 'BR').toUpperCase(),
      city: t.geo_city ?? null,
      state: t.geo_state ?? null,
      zip: t.geo_zip ?? null,
      external_id: externalId,
    },
    action_source: 'website',
    tracking: {
      event_id: eventId,
      // IDs de todos os eventos do funil: a PayTracking/Meta deduplica com os do Pixel do navegador
      initiate_checkout_event_id: t.initiate_checkout_event_id ?? null,
      add_payment_info_event_id: t.add_payment_info_event_id ?? null,
      purchase_event_id: t.purchase_event_id ?? (status === 'paid' ? eventId : null),
      external_id: externalId,
      pt_xid: t.pt_xid || t.external_id || null,
      visitor_id: t.visitor_id || t.session_id || null,
      fbp: t.fbp ?? null,
      fbc,
      fbclid: t.fbclid ?? null,
      utm_source: t.utm_source ?? null,
      utm_medium: t.utm_medium ?? null,
      utm_campaign: t.utm_campaign ?? null,
      utm_content: t.utm_content ?? null,
      utm_term: t.utm_term ?? null,
      utm_id: t.utm_id ?? null,
      src: t.src ?? null,
      sck: t.sck ?? null,
      xcod: t.xcod ?? null,
      gclid: t.gclid ?? null,
      ttclid: t.ttclid ?? null,
      page_url: t.page_url ?? null,
      referrer: t.referrer ?? null,
      client_ip_address: o.ip,
      client_user_agent: o.user_agent,
    },
  };
}

export function signPayTracking(body: string, secret: string, ts = Math.floor(Date.now() / 1000).toString()) {
  return { ts, signature: `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}` };
}

type Target = { url: string; token: string; secret: string };

async function transmit(target: Target, payload: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'PayTracking-Node/2.0.0 (+checkout-proprio)',
    ...extraHeaders,
  };
  if (target.token) headers.Authorization = `Bearer ${target.token}`;
  if (target.secret) {
    const { ts, signature } = signPayTracking(body, target.secret);
    headers['X-Paytrack-Timestamp'] = ts;
    headers['X-Paytrack-Signature'] = signature;
    headers['X-Webhook-Signature'] = signature; // mesmo valor, nome genérico para outros sistemas
  }
  const started = Date.now();
  let status = 0;
  let json: any = {};
  let error = '';
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetchWithTimeout(target.url, { method: 'POST', headers, body, timeoutMs: 8000, redirect: 'manual' });
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

/** Envia o evento da venda para todos os webhooks ativos inscritos nele (PayTracking e outros). */
export async function sendPayTracking(order: OrderForTracking, event: PayTrackingEvent): Promise<boolean> {
  try {
    const targets = await targetsFor(event);
    if (!targets.length) return false;
    const payload = buildPayload(order, event);
    const results = await Promise.all(
      targets.map(async (w) => {
        const r = await transmit(w, payload);
        const message = r.ok
          ? r.json?.duplicate
            ? 'duplicado (já recebido)'
            : String(r.json?.status ?? 'processado')
          : `${r.error} ${r.json?.error ?? ''} ${r.json?.reason ? `(${r.json.reason})` : ''}`.trim() || `HTTP ${r.status}`;
        await supabase.from('integration_logs').insert({
          integration: `webhook:${w.id}`,
          order_id: order.id,
          event,
          ok: r.ok,
          http_status: r.status,
          message: `${w.name}: ${message}`.slice(0, 500),
        });
        return r.ok;
      }),
    );
    return results.some(Boolean);
  } catch (e) {
    logger.error({ err: e, orderId: order.id }, 'Webhook de venda falhou');
    return false;
  }
}

/** Testa URL/token/segredo SEM registrar venda (o PayTracking não envia nada à Meta no teste). */
export async function testWebhook(target: Target & { name?: string }) {
  const r = await transmit(target, { event: 'connection_test', transaction_id: 'teste-de-conexao' }, { 'X-Paytrack-Test': '1' });
  if (r.ok) {
    const sig = r.json?.signature === 'valid' ? ', assinatura válida' : target.secret ? '' : ' (sem segredo de assinatura)';
    return { ok: true, status: r.status, message: `Conexão OK${sig}. Nenhuma venda foi registrada.` };
  }
  if (r.status === 401 || r.status === 403) {
    const reason = String(r.json?.reason ?? '');
    return { ok: false, status: r.status, message: reason.includes('signature') ? 'Segredo de assinatura diferente do configurado no destino.' : 'Token inválido ou integração pausada no destino.' };
  }
  if (r.status === 404) return { ok: false, status: r.status, message: 'URL não encontrada (404). Confira o endereço do webhook.' };
  if (r.status === 0) return { ok: false, status: 0, message: `Sem conexão: ${r.error}` };
  return { ok: false, status: r.status, message: `O destino respondeu HTTP ${r.status}` };
}

/** Compatibilidade: testa o primeiro webhook ativo. */
export async function testPayTracking() {
  const [first] = (await allWebhooks()).filter((w) => w.active);
  if (!first) return { ok: false, message: 'Nenhum webhook configurado. Adicione em Integrações → Webhooks.' };
  return testWebhook(first);
}
