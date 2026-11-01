import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { HttpError, logger, must, onlyDigits, supabase } from '../lib/core.js';
import { getProvider, type ProviderName } from '../providers/index.js';
import { sendDeliveryEmail, type DeliveryItem } from './email.js';
import { sendWhatsAppApproved } from './whatsapp.js';
import { checkCoupon, computeTotals, type CouponRow, type PriceLine } from './pricing.js';
import { sendPayTracking, type OrderForTracking, type PayTrackingEvent } from './paytracking.js';

const trackingKeys = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id', 'src', 'sck',
  'fbclid', 'fbp', 'fbc', 'gclid', 'ttclid', 'external_id', 'page_url', 'referrer',
  'event_id', 'initiate_checkout_event_id', 'purchase_event_id', 'session_id',
] as const;

export const createOrderSchema = z.object({
  checkout_slug: z.string().regex(/^[a-z0-9-]{3,60}$/),
  customer: z.object({
    name: z.string().trim().min(3, 'Informe seu nome completo').max(120),
    email: z.string().trim().toLowerCase().email('E-mail inválido').max(160),
    phone: z.string().trim().max(30).optional().nullable(),
    document: z.string().trim().max(20).optional().nullable(),
  }),
  bump_ids: z.array(z.string().uuid()).max(10).default([]),
  coupon_code: z.string().trim().toUpperCase().max(40).optional().nullable(),
  tracking: z.record(z.string(), z.unknown()).optional().default({}),
});
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

function sanitizeTracking(raw: Record<string, unknown>) {
  const out: Record<string, string> = {};
  for (const k of trackingKeys) {
    const v = raw[k];
    if (typeof v === 'string' && v.length > 0) out[k] = v.slice(0, 500);
  }
  // fbc/fbp: só aceita formato oficial da Meta (nunca alterar o valor)
  if (out.fbc && !/^fb\.\d+\.\d+\.[A-Za-z0-9_-]+$/.test(out.fbc)) delete out.fbc;
  if (out.fbp && !/^fb\.\d+\.\d+\.\d+$/.test(out.fbp)) delete out.fbp;
  out.purchase_event_id ??= `purchase_${crypto.randomUUID()}`;
  return out;
}

/**
 * Order bumps exibidos no checkout: todo bump ATIVO ligado ao checkout, na ordem definida.
 * O produto adicional pode estar inativo (vendido só como adicional) e bumps antigos podem
 * apontar para o próprio produto principal — nenhum desses casos esconde a oferta.
 * Nome/descrição/imagem vêm do produto adicional quando o bump não define.
 */
export function visibleBumps(rows: any[] | null | undefined) {
  return (rows ?? [])
    .filter((cb) => cb?.bump?.active)
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
    .map((cb) => ({
      ...cb.bump,
      title: cb.bump.title || cb.bump.product?.name || 'Oferta especial',
      description: cb.bump.description ?? cb.bump.product?.description ?? null,
      image_url: cb.bump.image_url || cb.bump.product?.image_url || null,
    }));
}

/** Carrega checkout ativo com produto e bumps vinculados. */
export async function loadCheckout(slug: string) {
  const checkout = must(
    await supabase
      .from('checkouts')
      .select('*, product:products(*), checkout_bumps(sort, bump:order_bumps(*, product:products(name, description, image_url, active)))')
      .eq('slug', slug)
      .eq('active', true)
      .maybeSingle(),
    'Checkout não encontrado',
  ) as any;
  if (!checkout.product?.active) throw new HttpError(404, 'Produto indisponível');
  const bumps = visibleBumps(checkout.checkout_bumps);
  return { ...checkout, bumps, price_cents: checkout.price_cents ?? checkout.product.price_cents };
}

async function findCoupon(code: string | null | undefined): Promise<CouponRow | null> {
  if (!code) return null;
  const { data } = await supabase.from('coupons').select('*').eq('code', code).maybeSingle();
  return (data as CouponRow) ?? null;
}

export async function quote(slug: string, bumpIds: string[], couponCode?: string | null) {
  const checkout = await loadCheckout(slug);
  const lines: PriceLine[] = [
    { kind: 'main', name: checkout.product.name, price_cents: checkout.price_cents, product_id: checkout.product.id },
  ];
  for (const id of new Set(bumpIds)) {
    const b = checkout.bumps.find((x: any) => x.id === id);
    if (!b) throw new HttpError(400, 'Oferta adicional inválida');
    lines.push({ kind: 'bump', name: b.title, price_cents: b.price_cents, product_id: b.product_id, bump_id: b.id });
  }
  const subtotal = lines.reduce((s, l) => s + l.price_cents, 0);
  let coupon: CouponRow | null = null;
  let discount = 0;
  let couponError: string | null = null;
  if (couponCode) {
    coupon = await findCoupon(couponCode);
    const c = checkCoupon(coupon, checkout.id, subtotal);
    if (c.ok) discount = c.discountCents;
    else {
      couponError = c.reason;
      coupon = null;
    }
  }
  return { checkout, lines, coupon, couponError, ...computeTotals(lines, discount) };
}

async function upsertCustomer(c: CreateOrderInput['customer']) {
  const row = { email: c.email, name: c.name, phone: onlyDigits(c.phone) || null, document: onlyDigits(c.document) || null };
  return must(await supabase.from('customers').upsert(row, { onConflict: 'email' }).select('id').single()) as { id: string };
}

export async function createOrder(input: CreateOrderInput, meta: { ip: string | null; userAgent: string | null }) {
  const q = await quote(input.checkout_slug, input.bump_ids, input.coupon_code);
  if (q.couponError) throw new HttpError(400, q.couponError);
  const { checkout } = q;

  const fields = checkout.fields ?? {};
  const doc = onlyDigits(input.customer.document);
  // CPF não é pedido no checkout; se vier (API), só é usado quando válido
  if (fields.phone && onlyDigits(input.customer.phone).length < 10) throw new HttpError(400, 'Telefone inválido');

  const provider = getProvider(checkout.provider as ProviderName);
  const customer = await upsertCustomer(input.customer);
  const tracking = sanitizeTracking(input.tracking);

  const order = must(
    await supabase
      .from('orders')
      .insert({
        checkout_id: checkout.id,
        customer_id: customer.id,
        provider: provider.name,
        subtotal_cents: q.subtotalCents,
        discount_cents: q.discountCents,
        total_cents: q.totalCents,
        coupon_id: q.coupon?.id ?? null,
        tracking,
        ip: meta.ip,
        user_agent: meta.userAgent?.slice(0, 400) ?? null,
      })
      .select('id, number, public_token')
      .single(),
  ) as { id: string; number: number; public_token: string };

  await supabase.from('order_items').insert(q.lines.map((l) => ({ ...l, order_id: order.id })));

  try {
    const charge = await provider.createCharge({
      orderId: order.id,
      amountCents: q.totalCents,
      description: `Pedido #${order.number} - ${checkout.product.name}`,
      expiresInSeconds: checkout.pix_expires_minutes * 60,
      customer: { name: input.customer.name, email: input.customer.email, phone: input.customer.phone, document: doc || null },
    });
    await supabase
      .from('orders')
      .update({
        provider_charge_id: charge.chargeId,
        pix_code: charge.pixCode,
        pix_qr_image: charge.qrImage,
        expires_at: charge.expiresAt.toISOString(),
      })
      .eq('id', order.id);

    await supabase.from('events').insert({ checkout_id: checkout.id, order_id: order.id, type: 'pix_generated', session_id: tracking.session_id ?? null, data: { total_cents: q.totalCents } });
    // Rastreamento sem bloquear a resposta ao comprador
    void dispatchTracking(order.id, 'sale.pending');

    return { token: order.public_token };
  } catch (e: any) {
    await supabase.from('orders').update({ status: 'failed', error: String(e?.message ?? e).slice(0, 500) }).eq('id', order.id);
    logger.error({ orderId: order.id, err: e?.message }, 'Falha ao gerar PIX');
    throw e instanceof HttpError ? e : new HttpError(502, 'Não foi possível gerar o PIX. Tente novamente.');
  }
}

export async function loadOrderForTracking(orderId: string): Promise<OrderForTracking | null> {
  const { data } = await supabase
    .from('orders')
    .select('id, number, provider, total_cents, created_at, ip, user_agent, tracking, checkout:checkouts(slug), customer:customers(name, email, phone, document), items:order_items(kind, name, price_cents, product_id, bump_id, product:products(number))')
    .eq('id', orderId)
    .maybeSingle();
  if (!data) return null;
  const d: any = data;
  return { ...d, checkout_slug: d.checkout?.slug ?? null };
}

export async function dispatchTracking(orderId: string, event: PayTrackingEvent) {
  try {
    const o = await loadOrderForTracking(orderId);
    if (o) await sendPayTracking(o, event);
  } catch (e) {
    logger.error({ err: e, orderId }, 'dispatchTracking falhou');
  }
}

/** Links de entrega (arquivos privados viram URL assinada de 7 dias). */
export async function deliveryItems(orderId: string): Promise<DeliveryItem[]> {
  const { data } = await supabase
    .from('order_items')
    .select('name, product:products(delivery_type, delivery_url, delivery_note)')
    .eq('order_id', orderId);
  const items: DeliveryItem[] = [];
  for (const it of (data ?? []) as any[]) {
    const p = it.product;
    let url: string | null = null;
    if (p?.delivery_type === 'link') url = p.delivery_url ?? null;
    if (p?.delivery_type === 'file' && p.delivery_url) {
      const { data: s } = await supabase.storage.from('deliverables').createSignedUrl(p.delivery_url, 60 * 60 * 24 * 7);
      url = s?.signedUrl ?? null;
    }
    items.push({ name: it.name, url, note: p?.delivery_note ?? null });
  }
  return items;
}

async function fulfill(orderId: string) {
  const { data: o } = await supabase
    .from('orders')
    .select('id, number, public_token, delivered_at, customer:customers(name, email), checkout:checkouts(theme)')
    .eq('id', orderId)
    .maybeSingle();
  const order: any = o;
  if (!order || order.delivered_at || !order.customer) return;
  const ok = await sendDeliveryEmail({
    orderId,
    orderNumber: order.number,
    to: order.customer.email,
    name: order.customer.name,
    items: await deliveryItems(orderId),
    accessUrl: `${env.PUBLIC_URL}/pedido/${order.public_token}`,
    accent: order.checkout?.theme?.primaryColor,
  });
  if (ok) await supabase.from('orders').update({ delivered_at: new Date().toISOString() }).eq('id', orderId);
}

/**
 * Confirma pagamento SEMPRE consultando o gateway (nunca confia só no corpo do webhook).
 * Idempotente: só a primeira chamada efetiva dispara entrega e tracking.
 */
export async function syncOrderWithProvider(orderId: string): Promise<string> {
  const { data } = await supabase
    .from('orders')
    .select('id, status, provider, provider_charge_id, total_cents, checkout_id, tracking')
    .eq('id', orderId)
    .maybeSingle();
  const order: any = data;
  if (!order?.provider_charge_id) return 'not_found';
  if (order.status === 'paid') return 'already_paid';

  const info = await getProvider(order.provider).getCharge(order.provider_charge_id);
  if (info.status === 'paid') {
    if (info.paidAmountCents !== undefined && info.paidAmountCents < order.total_cents) {
      logger.warn({ orderId, paid: info.paidAmountCents, expected: order.total_cents }, 'Valor pago menor que o pedido');
      await supabase.from('orders').update({ error: `Valor pago (${info.paidAmountCents}) menor que o total` }).eq('id', orderId);
      return 'amount_mismatch';
    }
    const { data: transitioned, error } = await supabase.rpc('mark_order_paid', { p_order_id: orderId });
    if (error) throw new HttpError(500, error.message);
    if (transitioned) {
      await supabase.from('events').insert({ checkout_id: order.checkout_id, order_id: orderId, type: 'purchase', data: { total_cents: order.total_cents } });
      await Promise.allSettled([
        fulfill(orderId),
        dispatchTracking(orderId, 'sale.approved'),
        deliveryItems(orderId).then((items) => sendWhatsAppApproved(orderId, items.map((it, i) => ({ ...it, kind: i === 0 ? 'main' : 'bump' })))),
      ]);
      return 'paid';
    }
    return 'already_paid';
  }
  if (info.status === 'expired' && order.status === 'pending') {
    await supabase.from('orders').update({ status: 'expired' }).eq('id', orderId).eq('status', 'pending');
    void dispatchTracking(orderId, 'sale.canceled');
    return 'expired';
  }
  return info.status;
}

export async function findOrderByCharge(provider: ProviderName, chargeId: string) {
  const { data } = await supabase.from('orders').select('id').eq('provider', provider).eq('provider_charge_id', chargeId).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

export async function resendDelivery(orderId: string) {
  await supabase.from('orders').update({ delivered_at: null }).eq('id', orderId).eq('status', 'paid');
  await fulfill(orderId);
}
