import { ensureMemberAccess, membersLink } from './members.js';
import { assertCanSell, isOwnerOrg, orgInfo, orgOfOrder, runAsOrg, withOrderOrg } from '../lib/tenant.js';
import type { SplitSpec } from '../providers/types.js';
import { feeFieldsFor } from './fees.js';
import { recordSale } from './ledger.js';
import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from '../config/env.js';
import { HttpError, logger, must, onlyDigits, productCode, supabase } from '../lib/core.js';
import { getProvider, type ProviderName } from '../providers/index.js';
import { cardConfig, globalProvider, pixExpiresMinutes } from './gateways.js';
import { pixQrDataUrl } from '../lib/qr.js';
import { emitInvoice } from './invoices.js';
import { sendDeliveryEmail, type DeliveryItem } from './email.js';
import { sendWhatsAppApproved } from './whatsapp.js';
import { checkCoupon, computeTotals, type CouponRow, type PriceLine } from './pricing.js';
import { sendPayTracking, type OrderForTracking, type PayTrackingEvent } from './paytracking.js';

const trackingKeys = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id', 'src', 'sck',
  'fbclid', 'fbp', 'fbc', 'gclid', 'ttclid', 'external_id', 'page_url', 'referrer',
  'event_id', 'initiate_checkout_event_id', 'purchase_event_id', 'session_id',
  'pt_xid', 'xcod', 'visitor_id', 'fbclid_at', 'add_payment_info_event_id',
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
  /** forma de pagamento escolhida no checkout (padrão Pix) */
  payment_method: z.enum(['pix', 'card']).optional().default('pix'),
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

// Cache curto da configuração do checkout (cada visita evitava 1 consulta pesada ao banco).
// Limpo a cada alteração feita no painel, então mudanças aparecem na hora.
const checkoutCache = new Map<string, { at: number; data: any }>();
const CHECKOUT_TTL = 15_000;
export function clearCheckoutCache() {
  checkoutCache.clear();
}

/** Carrega checkout ativo com produto e bumps vinculados (com cache de 15s). */
export async function loadCheckout(slug: string) {
  const hit = checkoutCache.get(slug);
  if (hit && Date.now() - hit.at < CHECKOUT_TTL) return hit.data;
  const data = await loadCheckoutFresh(slug);
  checkoutCache.set(slug, { at: Date.now(), data });
  if (checkoutCache.size > 500) checkoutCache.delete(checkoutCache.keys().next().value!);
  return data;
}

async function loadCheckoutFresh(slug: string) {
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

async function findCoupon(code: string | null | undefined, orgId?: string | null): Promise<CouponRow | null> {
  if (!code) return null;
  // cupom vale só nos checkouts do produtor que o criou
  let q = supabase.from('coupons').select('*').eq('code', code);
  if (orgId) q = q.eq('org_id', orgId);
  const { data } = await q.maybeSingle();
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
    coupon = await findCoupon(couponCode, checkout.org_id ?? null);
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

/** Gera o pedido + Pix com as configurações do produtor dono do checkout (PayTracking, loja, taxas). */
export async function createOrder(input: CreateOrderInput, meta: { ip: string | null; userAgent: string | null; geo?: Record<string, string> }) {
  const ck = await loadCheckout(input.checkout_slug);
  return runAsOrg(ck.org_id ?? null, () => createOrderImpl(input, meta));
}
async function createOrderImpl(input: CreateOrderInput, meta: { ip: string | null; userAgent: string | null; geo?: Record<string, string> }) {
  const q = await quote(input.checkout_slug, input.bump_ids, input.coupon_code);
  if (q.couponError) throw new HttpError(400, q.couponError);
  const { checkout } = q;

  const fields = checkout.fields ?? {};
  const doc = onlyDigits(input.customer.document);
  // CPF não é pedido no checkout; se vier (API), só é usado quando válido
  if (fields.phone && onlyDigits(input.customer.phone).length < 10) throw new HttpError(400, 'Telefone inválido');

  // produtor só vende com conta ativa e recebimento (split) liberado; a Prime vende sempre
  await assertCanSell(checkout.org_id);
  const method = input.payment_method ?? 'pix';
  const card = method === 'card' ? await cardAllowed(checkout.org_id) : null;
  if (card && onlyDigits(input.customer.document).length !== 11 && onlyDigits(input.customer.document).length !== 14) throw new HttpError(400, 'Informe um CPF válido para pagar com cartão');
  // gateway: cartão → o do cartão (Super Admin); Pix → o do produtor, senão o global (Integrações), senão o do checkout
  const provider = getProvider((card ? card.provider : ((await orgInfo(checkout.org_id))?.pix_provider ?? globalProvider() ?? checkout.provider)) as ProviderName);
  const customer = await upsertCustomer(input.customer);

  // Sem cobrança duplicada: a mesma pessoa, no mesmo checkout, com o MESMO valor (e itens)
  // e um Pix ainda válido recebe de volta esse Pix. Valor diferente = cobrança nova (a anterior continua).
  const reuse = method === 'pix' ? await findReusablePix(checkout.id, customer.id, q) : null;
  if (reuse) return reuse;

  // geo vem só do servidor (cabeçalhos da CDN), nunca do navegador
  const tracking = { ...sanitizeTracking(input.tracking), ...(meta.geo ?? {}) };

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
        // comissão da plataforma calculada no servidor e congelada no pedido (R$ 0,00 para a Prime)
        ...(await feeFieldsFor(checkout.org_id ?? null, q.lines, q.totalCents)),
        ...(card ? { payment_method: 'card' } : {}),
      })
      .select('id, number, public_token, created_at')
      .single(),
  ) as { id: string; number: number; public_token: string; created_at: string };

  // itens gravados em paralelo com a geração do Pix (não precisa esperar um pelo outro)
  const itemsSaved = supabase.from('order_items').insert(q.lines.map((l) => ({ ...l, order_id: order.id })));

  try {
    const charge = await provider.createCharge({
      orderId: order.id,
      amountCents: q.totalCents,
      description: `Pedido #${order.number} - ${checkout.product.name}`,
      expiresInSeconds: pixExpiresMinutes() * 60, // validade real definida em Integrações (padrão 2 h)
      customer: { name: input.customer.name, email: input.customer.email, phone: input.customer.phone, document: doc || null },
      method,
      cardInstallments: card?.maxInstallments,
      split: await splitFor(order.id), // venda de produtor: a parte dele vai direto para o recebedor dele
    });
    // QR Code gerado aqui mesmo a partir do copia e cola: sai na hora, sem baixar imagem do gateway
    const qrImage = charge.pixCode ? ((await pixQrDataUrl(charge.pixCode)) ?? charge.qrImage) : null;
    const expiresAt = charge.expiresAt.toISOString();
    await Promise.all([
      itemsSaved,
      supabase
        .from('orders')
        .update({ provider_charge_id: charge.chargeId, pix_code: charge.pixCode || null, pix_qr_image: qrImage, expires_at: expiresAt, ...(charge.cardUrl ? { card_checkout_url: charge.cardUrl } : {}) })
        .eq('id', order.id),
      saveSplit(order.id, charge.splitInfo),
    ]);

    // MESMO valor (mesmo ticket) da mesma pessoa neste checkout: a cobrança anterior (ex.: Pix vencido)
    // é substituída por esta, para ficar só uma no painel. Valores diferentes ficam como estão.
    void supabase
      .from('orders')
      .update({ status: 'canceled', error: `Substituído pelo pedido ${productCode(order.number)}` })
      .eq('checkout_id', checkout.id)
      .eq('customer_id', customer.id)
      .eq('status', 'pending')
      .eq('total_cents', q.totalCents)
      .neq('id', order.id)
      .lt('created_at', order.created_at) // só as anteriores: dois envios simultâneos não se cancelam
      .then(() => {});
    void supabase.from('events').insert({ checkout_id: checkout.id, order_id: order.id, type: 'pix_generated', session_id: tracking.session_id ?? null, data: { total_cents: q.totalCents } }).then(() => {});
    // Rastreamento sem bloquear a resposta ao comprador
    void dispatchTracking(order.id, 'sale.pending');

    // a página do Pix abre já com estes dados (sem esperar outra consulta)
    return {
      token: order.public_token,
      order: {
        number: order.number,
        status: 'pending',
        total_cents: q.totalCents,
        subtotal_cents: q.subtotalCents,
        discount_cents: q.discountCents,
        pix_code: charge.pixCode || null,
        pix_qr_image: qrImage,
        payment_method: method,
        card_url: charge.cardUrl ?? null,
        expires_at: expiresAt,
        paid_at: null,
        created_at: new Date().toISOString(),
        items: q.lines.map((l) => ({ kind: l.kind, name: l.name, price_cents: l.price_cents })),
        content_ids: [productCode(checkout.product.number)].filter(Boolean),
        external_id: tracking.external_id || tracking.pt_xid || customer.id,
        customer: { name: input.customer.name, email: input.customer.email, phone: onlyDigits(input.customer.phone) || null },
        checkout: { slug: checkout.slug, name: checkout.name, theme: checkout.theme, metaPixelId: checkout.tracking?.metaPixelId ?? null },
        purchase_event_id: (tracking as any).purchase_event_id ?? null,
        delivery: [],
      },
    };
  } catch (e: any) {
    await supabase.from('orders').update({ status: 'failed', error: String(e?.message ?? e).slice(0, 500) }).eq('id', order.id);
    logger.error({ orderId: order.id, err: e?.message }, 'Falha ao gerar PIX');
    throw e instanceof HttpError ? e : new HttpError(502, 'Não foi possível gerar o PIX. Tente novamente.');
  }
}

export async function loadOrderForTracking(orderId: string): Promise<OrderForTracking | null> {
  const { data } = await supabase
    .from('orders')
    .select('id, number, provider, total_cents, created_at, ip, user_agent, tracking, customer_id, checkout:checkouts(slug), customer:customers(name, email, phone, document), items:order_items(kind, name, price_cents, product_id, bump_id, product:products(number))')
    .eq('id', orderId)
    .maybeSingle();
  if (!data) return null;
  const d: any = data;
  return { ...d, checkout_slug: d.checkout?.slug ?? null };
}

export async function dispatchTracking(orderId: string, event: PayTrackingEvent) {
  return withOrderOrg(orderId, () => dispatchTrackingImpl(orderId, event));
}
async function dispatchTrackingImpl(orderId: string, event: PayTrackingEvent) {
  try {
    const o = await loadOrderForTracking(orderId);
    if (o) await sendPayTracking(o, event);
  } catch (e) {
    logger.error({ err: e, orderId }, 'dispatchTracking falhou');
  }
}

/** Links de entrega (arquivos privados viram URL assinada de 7 dias). */
export async function deliveryItems(orderId: string): Promise<DeliveryItem[]> {
  const [{ data }, { data: ord }] = await Promise.all([
    supabase
      .from('order_items')
      .select('name, kind, product:products(image_url, delivery_type, delivery_url, delivery_note, members_enabled)')
      .eq('order_id', orderId)
      .order('kind', { ascending: false }), // "main" antes de "bump"
    supabase.from('orders').select('public_token').eq('id', orderId).maybeSingle(),
  ]);
  const items: DeliveryItem[] = [];
  for (const it of (data ?? []) as any[]) {
    const p = it.product;
    let url: string | null = null;
    // produto com área de membros: o acesso é a própria área (entra direto, sem senha, pelo link do pedido)
    if (p?.members_enabled && (ord as any)?.public_token) {
      items.push({ name: it.name, url: membersLink((ord as any).public_token), note: p?.delivery_note ?? null, image: p?.image_url ?? null, kind: it.kind });
      continue;
    }
    if (p?.delivery_type === 'link') url = p.delivery_url ?? null;
    if (p?.delivery_type === 'file' && p.delivery_url) {
      const { data: s } = await supabase.storage.from('deliverables').createSignedUrl(p.delivery_url, 60 * 60 * 24 * 7);
      url = s?.signedUrl ?? null;
    }
    items.push({ name: it.name, url, note: p?.delivery_note ?? null, image: p?.image_url ?? null, kind: it.kind });
  }
  return items;
}

export async function fulfill(orderId: string) {
  return withOrderOrg(orderId, () => fulfillImpl(orderId));
}
async function fulfillImpl(orderId: string) {
  const { data: o } = await supabase
    .from('orders')
    .select('id, number, public_token, total_cents, delivered_at, customer:customers(name, email), checkout:checkouts(theme)')
    .eq('id', orderId)
    .maybeSingle();
  const order: any = o;
  if (!order || order.delivered_at || !order.customer) return;
  const ok = await sendDeliveryEmail({
    orderId,
    orderCode: productCode(order.number),
    to: order.customer.email,
    name: order.customer.name ?? '',
    totalCents: order.total_cents,
    items: await deliveryItems(orderId),
    accessUrl: `${env.PUBLIC_URL}/pedido/${order.public_token}`,
    accent: order.checkout?.theme?.primaryColor,
    members: await ensureMemberAccess(orderId).catch(() => null), // login + senha da área de membros
  });
  if (ok) await supabase.from('orders').update({ delivered_at: new Date().toISOString() }).eq('id', orderId);
}

/**
 * Confirma pagamento SEMPRE consultando o gateway (nunca confia só no corpo do webhook).
 * Idempotente: só a primeira chamada efetiva dispara entrega e tracking.
 */
export async function syncOrderWithProvider(orderId: string): Promise<string> {
  return withOrderOrg(orderId, () => syncOrderImpl(orderId));
}
async function syncOrderImpl(orderId: string): Promise<string> {
  const { data } = await supabase
    .from('orders')
    .select('id, status, provider, provider_charge_id, total_cents, checkout_id, tracking')
    .eq('id', orderId)
    .maybeSingle();
  const order: any = data;
  if (!order?.provider_charge_id) return 'not_found';
  if (order.status === 'paid') return 'already_paid';

  const info = await getProvider(order.provider).getCharge(order.provider_charge_id);
  if (info.status === 'paid' && order.status === 'canceled') {
    // o cliente pagou um Pix que o sistema tinha substituído (ainda válido no banco): dinheiro recebido
    // = acesso liberado. Reabre o pedido para a confirmação normal abaixo (entrega, nota, rastreamento).
    await supabase.from('orders').update({ status: 'pending', error: null }).eq('id', orderId).eq('status', 'canceled');
    logger.warn({ orderId }, 'Pix pago em pedido cancelado: pedido reaberto e confirmado');
  }
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
        recordSale(orderId), // livro-razão: venda + comissão (uma vez por pedido)
        fulfill(orderId),
        dispatchTracking(orderId, 'sale.approved'),
        emitInvoice(orderId), // uma nota por venda (produto + order bumps)
        deliveryItems(orderId).then((items) => sendWhatsAppApproved(orderId, items.map((it, i) => ({ ...it, kind: i === 0 ? 'main' : 'bump' })))),
      ]);
      return 'paid';
    }
    return 'already_paid';
  }
  if (info.status === 'expired' && order.status === 'pending') {
    // o pedido CONTINUA pendente no painel (vendas pendentes); só avisa os webhooks uma vez
    await notifyPixExpired(orderId, order.checkout_id);
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

/**
 * Pix vencido: o pedido permanece "pendente" (para recuperação e acompanhamento),
 * mas os webhooks (PayTracking etc.) recebem `sale.canceled` uma única vez.
 */
export async function notifyPixExpired(orderId: string, checkoutId: string | null) {
  const { count } = await supabase.from('events').select('id', { count: 'exact', head: true }).eq('order_id', orderId).eq('type', 'pix_expired');
  if (count) return false;
  await supabase.from('events').insert({ order_id: orderId, checkout_id: checkoutId, type: 'pix_expired', data: {} });
  void dispatchTracking(orderId, 'sale.canceled');
  return true;
}

/**
 * Pix vencido → novo Pix com UM toque, sem preencher nada de novo.
 * Gera uma nova cobrança para a mesma compra (mesmos itens, preço e cupom já aplicados);
 * o pedido antigo é encerrado como "cancelado" (substituído) para não duplicar vendas pendentes.
 * Se o Pix atual ainda estiver válido, devolve o mesmo pedido.
 */
export async function renewOrder(token: string): Promise<{ token: string; renewed: boolean }> {
  const { data } = await supabase
    .from('orders')
    .select('id, status, expires_at, public_token, checkout_id, customer_id, subtotal_cents, discount_cents, total_cents, coupon_id, tracking, ip, user_agent, customer:customers(name, email, phone, document), items:order_items(kind, name, price_cents, product_id, bump_id)')
    .eq('public_token', token)
    .maybeSingle();
  const old: any = data;
  if (!old) throw new HttpError(404, 'Pedido não encontrado');
  if (old.status === 'paid') return { token: old.public_token, renewed: false };
  if (old.status === 'canceled') {
    // link antigo de um Pix já renovado: segue para o pedido mais novo dessa compra
    const { data: next } = await supabase.from('orders').select('public_token').eq('tracking->>renewed_from', old.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (next) return renewOrder((next as any).public_token);
  }
  if (old.status !== 'pending') throw new HttpError(400, 'Este pedido não pode mais ser pago. Faça um novo pedido pelo checkout.');
  if (old.expires_at && new Date(old.expires_at).getTime() > Date.now() + 30_000) return { token: old.public_token, renewed: false };

  const { data: ck } = await supabase.from('checkouts').select('id, slug, name, provider, pix_expires_minutes, theme, tracking, product:products(name, number)').eq('id', old.checkout_id).maybeSingle();
  const checkout: any = ck;
  if (!checkout) throw new HttpError(404, 'Checkout não encontrado');
  const ckOrg = await orgOfOrder(old.id);
  await assertCanSell(ckOrg);
  const provider = getProvider(((await orgInfo(ckOrg))?.pix_provider ?? globalProvider() ?? checkout.provider) as ProviderName);

  const tracking = { ...(old.tracking ?? {}), renewed_from: old.id };
  const order = must(
    await supabase
      .from('orders')
      .insert({
        checkout_id: old.checkout_id,
        customer_id: old.customer_id,
        provider: provider.name,
        subtotal_cents: old.subtotal_cents,
        discount_cents: old.discount_cents,
        total_cents: old.total_cents,
        coupon_id: old.coupon_id,
        tracking,
        ip: old.ip,
        user_agent: old.user_agent,
        recovery_sent_at: new Date().toISOString(), // a pessoa já voltou: sem novo e-mail de recuperação
        ...(await feeFieldsFor(ckOrg, old.items ?? [], old.total_cents)),
      })
      .select('id, number, public_token')
      .single(),
  ) as { id: string; number: number; public_token: string };
  const itemsSaved = supabase.from('order_items').insert(old.items.map((i: any) => ({ kind: i.kind, name: i.name, price_cents: i.price_cents, product_id: i.product_id, bump_id: i.bump_id, order_id: order.id })));

  try {
    const charge = await provider.createCharge({
      orderId: order.id,
      amountCents: old.total_cents,
      description: `Pedido #${order.number} - ${checkout.product?.name ?? checkout.name}`,
      expiresInSeconds: pixExpiresMinutes() * 60, // validade real definida em Integrações (padrão 2 h)
      customer: { name: old.customer?.name ?? '', email: old.customer?.email ?? '', phone: old.customer?.phone ?? null, document: old.customer?.document ?? null },
      split: await splitFor(order.id),
    });
    void saveSplit(order.id, charge.splitInfo);
    const qrImage = (await pixQrDataUrl(charge.pixCode)) ?? charge.qrImage;
    const expiresAt = charge.expiresAt.toISOString();
    await Promise.all([
      itemsSaved,
      supabase.from('orders').update({ provider_charge_id: charge.chargeId, pix_code: charge.pixCode, pix_qr_image: qrImage, expires_at: expiresAt }).eq('id', order.id),
      supabase.from('orders').update({ status: 'canceled', error: `Pix renovado no pedido ${productCode(order.number)}` }).eq('id', old.id).eq('status', 'pending'),
      // a tentativa de recuperação já feita conta para o novo pedido (não reinicia os lembretes)
      supabase.from('events').insert([
        { checkout_id: old.checkout_id, order_id: order.id, type: 'pix_generated', data: { total_cents: old.total_cents, renewed_from: old.id } },
        { checkout_id: old.checkout_id, order_id: order.id, type: 'wa_recovery', data: { attempt: 'renewed' } },
        { checkout_id: old.checkout_id, order_id: order.id, type: 'wa_recovery', data: { attempt: 'renewed' } },
      ]),
    ]);
    return { token: order.public_token, renewed: true };
  } catch (e: any) {
    await supabase.from('orders').update({ status: 'failed', error: String(e?.message ?? e).slice(0, 500) }).eq('id', order.id);
    logger.error({ orderId: order.id, err: e?.message }, 'Falha ao renovar PIX');
    throw e instanceof HttpError ? e : new HttpError(502, 'Não foi possível gerar o novo Pix. Tente novamente.');
  }
}

/** Oferta de upsell para um pedido pago (null se não houver ou se já foi comprada). */
export async function upsellOfferFor(order: { id: string; status: string; tracking?: any; items: { kind: string; product_id?: string | null }[] }) {
  if (order.status !== 'paid' || order.tracking?.upsell_of) return null; // pedido de upsell não oferece outro upsell
  const mainProduct = order.items.find((i) => i.kind === 'main')?.product_id;
  if (!mainProduct) return null;
  const { data: u } = await supabase
    .from('upsells')
    .select('id, headline, title, description, image_url, price_cents, compare_at_cents, cta_text, active, offer:products!upsells_offer_product_id_fkey(name, description, image_url)')
    .eq('product_id', mainProduct)
    .eq('active', true)
    .maybeSingle();
  const up: any = u;
  if (!up) return null;
  const { data: prev } = await supabase.from('orders').select('public_token, status').eq('tracking->>upsell_of', order.id).in('status', ['pending', 'paid']).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if ((prev as any)?.status === 'paid') return null;
  return {
    id: up.id,
    headline: up.headline || 'Espere! Seu pedido pode ficar ainda melhor',
    title: up.title || up.offer?.name || 'Oferta especial',
    description: up.description ?? up.offer?.description ?? null,
    image_url: up.image_url || up.offer?.image_url || null,
    price_cents: up.price_cents,
    compare_at_cents: up.compare_at_cents ?? null,
    cta_text: up.cta_text || null,
    pending_token: (prev as any)?.public_token ?? null,
  };
}

/**
 * Cliente aceitou o upsell: cria um pedido novo só com o produto oferecido (Pix próprio),
 * com os dados do comprador do pedido original (nada para preencher). Idempotente.
 */
export async function createUpsellOrder(parentToken: string): Promise<{ token: string }> {
  const { data } = await supabase
    .from('orders')
    .select('id, status, checkout_id, customer_id, tracking, ip, user_agent, customer:customers(name, email, phone, document), items:order_items(kind, product_id)')
    .eq('public_token', parentToken)
    .maybeSingle();
  const parent: any = data;
  if (!parent) throw new HttpError(404, 'Pedido não encontrado');
  const offer = await upsellOfferFor(parent);
  if (!offer) throw new HttpError(400, 'Esta oferta não está mais disponível');
  if (offer.pending_token) return renewOrder(offer.pending_token); // já aceitou antes: reabre (ou renova) o mesmo Pix

  const { data: up } = await supabase.from('upsells').select('offer_product_id').eq('id', offer.id).single();
  const { data: ck } = await supabase.from('checkouts').select('id, name, provider, pix_expires_minutes').eq('id', parent.checkout_id).maybeSingle();
  const checkout: any = ck;
  if (!checkout || !up) throw new HttpError(404, 'Oferta indisponível');
  const provider = getProvider((globalProvider() ?? checkout.provider) as ProviderName);
  const { initiate_checkout_event_id: _ic, add_payment_info_event_id: _api, purchase_event_id: _pe, event_id: _e, renewed_from: _r, ...keep } = parent.tracking ?? {};
  const tracking = { ...keep, upsell_of: parent.id, purchase_event_id: `purchase_${crypto.randomUUID()}` };

  const order = must(
    await supabase
      .from('orders')
      .insert({
        checkout_id: parent.checkout_id,
        customer_id: parent.customer_id,
        provider: provider.name,
        subtotal_cents: offer.price_cents,
        discount_cents: 0,
        total_cents: offer.price_cents,
        tracking,
        ip: parent.ip,
        user_agent: parent.user_agent,
        recovery_sent_at: new Date().toISOString(), // upsell não entra na recuperação por e-mail
        ...(await feeFieldsFor(await orgOfOrder(parent.id), [{ kind: 'main', price_cents: offer.price_cents }], offer.price_cents)),
      })
      .select('id, number, public_token')
      .single(),
  ) as { id: string; number: number; public_token: string };
  const itemsSaved = supabase.from('order_items').insert({ order_id: order.id, kind: 'main', name: offer.title, price_cents: offer.price_cents, product_id: (up as any).offer_product_id });

  try {
    const charge = await provider.createCharge({
      orderId: order.id,
      amountCents: offer.price_cents,
      description: `Pedido #${order.number} - ${offer.title}`,
      expiresInSeconds: pixExpiresMinutes() * 60, // validade real definida em Integrações (padrão 2 h)
      customer: { name: parent.customer?.name ?? '', email: parent.customer?.email ?? '', phone: parent.customer?.phone ?? null, document: parent.customer?.document ?? null },
      split: await splitFor(order.id),
    });
    void saveSplit(order.id, charge.splitInfo);
    const qrImage = (await pixQrDataUrl(charge.pixCode)) ?? charge.qrImage;
    await Promise.all([
      itemsSaved,
      supabase.from('orders').update({ provider_charge_id: charge.chargeId, pix_code: charge.pixCode, pix_qr_image: qrImage, expires_at: charge.expiresAt.toISOString() }).eq('id', order.id),
      supabase.from('events').insert([
        { checkout_id: parent.checkout_id, order_id: order.id, type: 'upsell_accepted', data: { upsell_id: offer.id, parent: parent.id } },
        { checkout_id: parent.checkout_id, order_id: order.id, type: 'pix_generated', data: { total_cents: offer.price_cents, upsell_of: parent.id } },
        // sem lembretes de recuperação por WhatsApp para o upsell (não incomodar quem acabou de comprar)
        { checkout_id: parent.checkout_id, order_id: order.id, type: 'wa_recovery', data: { attempt: 'upsell' } },
        { checkout_id: parent.checkout_id, order_id: order.id, type: 'wa_recovery', data: { attempt: 'upsell' } },
      ]),
    ]);
    void dispatchTracking(order.id, 'sale.pending');
    return { token: order.public_token };
  } catch (e: any) {
    await supabase.from('orders').update({ status: 'failed', error: String(e?.message ?? e).slice(0, 500) }).eq('id', order.id);
    logger.error({ orderId: order.id, err: e?.message }, 'Falha ao gerar Pix do upsell');
    throw e instanceof HttpError ? e : new HttpError(502, 'Não foi possível gerar o Pix agora. Tente novamente.');
  }
}

// ------------------------------------------------------------------ split e cartão (marketplace)
/**
 * Divisão da venda no gateway: produtor recebe (total − comissão) direto no recebedor dele; a comissão
 * fica com a Prime. Vendas da Prime não têm split (recebe como sempre).
 */
async function splitFor(orderId: string): Promise<SplitSpec | null> {
  const { data } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle(); // '*': funciona sem as colunas novas
  const o: any = data;
  if (!o?.org_id || (await isOwnerOrg(o.org_id))) return null;
  const org = await orgInfo(o.org_id);
  const r: any = org?.recipient ?? {};
  const fee = Number(o.platform_fee_cents ?? 0);
  const producerCents = o.total_cents - fee;
  if (producerCents <= 0) return null; // comissão = venda inteira: nada a repassar
  return { producerCents, platformCents: fee, recipient: { pixKey: r.pix_key ?? r.pixKey, account: r.account, document: r.document, name: r.name } };
}
async function saveSplit(orderId: string, info: Record<string, unknown> | null | undefined) {
  if (!info) return;
  const { error } = await supabase.from('orders').update({ split_info: info, split_status: 'pending' }).eq('id', orderId);
  if (error) logger.warn({ orderId, err: error.message }, 'Split: não foi possível registrar no pedido (rode o SQL 20261113)');
}

/**
 * Cartão: ligado pelo Super Admin e com gateway pronto. Para produtores, só com split de cartão
 * habilitado (a Woovi não documenta split no cartão): sem isso, o dinheiro de terceiros cairia na conta da Prime.
 */
async function cardAllowed(orgId: string | null | undefined) {
  const cc = cardConfig();
  if (!cc.enabled) throw new HttpError(400, 'Pagamento com cartão indisponível no momento. Use o Pix.');
  if (!(await isOwnerOrg(orgId)) && !(await orgInfo(orgId))?.card_split_enabled) throw new HttpError(400, 'Pagamento com cartão indisponível para este produto. Use o Pix.');
  return cc;
}

/** Cartão aparece no checkout? (mesma regra do servidor, sem lançar erro) */
export async function cardOptionFor(orgId: string | null | undefined) {
  const cc = cardConfig();
  if (!cc.enabled) return null;
  if (!(await isOwnerOrg(orgId)) && !(await orgInfo(orgId))?.card_split_enabled) return null;
  return { maxInstallments: cc.maxInstallments };
}

/** Pix pendente e ainda válido da mesma pessoa para a mesma compra (itens + valor), pronto para reaproveitar. */
async function findReusablePix(checkoutId: string, customerId: string, q: Awaited<ReturnType<typeof quote>>) {
  const since = new Date(Date.now() - 48 * 3600_000).toISOString();
  const { data } = await supabase
    .from('orders')
    .select('id, number, public_token, status, total_cents, subtotal_cents, discount_cents, pix_code, pix_qr_image, expires_at, created_at, tracking, customer:customers(name, email, phone), items:order_items(kind, name, price_cents, product_id, bump_id)')
    .eq('checkout_id', checkoutId)
    .eq('customer_id', customerId)
    .eq('status', 'pending')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(5);
  const key = (items: { kind: string; product_id?: string | null; bump_id?: string | null }[]) =>
    items.map((i) => `${i.kind}:${i.bump_id ?? i.product_id ?? ''}`).sort().join('|');
  const wanted = key(q.lines);
  const o: any = ((data ?? []) as any[]).find(
    (x) => x.pix_code && x.total_cents === q.totalCents && x.expires_at && new Date(x.expires_at).getTime() > Date.now() + 60_000 && key(x.items ?? []) === wanted,
  );
  if (!o) return null;
  const { checkout } = q;
  return {
    token: o.public_token as string,
    reused: true,
    order: {
      number: o.number,
      status: 'pending',
      total_cents: o.total_cents,
      subtotal_cents: o.subtotal_cents,
      discount_cents: o.discount_cents,
      pix_code: o.pix_code,
      pix_qr_image: o.pix_qr_image,
      expires_at: o.expires_at,
      paid_at: null,
      created_at: o.created_at,
      items: (o.items ?? []).map((l: any) => ({ kind: l.kind, name: l.name, price_cents: l.price_cents })),
      customer: o.customer ? { name: o.customer.name, email: o.customer.email, phone: o.customer.phone } : null,
      checkout: { slug: checkout.slug, name: checkout.name, theme: checkout.theme, metaPixelId: checkout.tracking?.metaPixelId ?? null },
      content_ids: [productCode(checkout.product.number)].filter(Boolean),
      external_id: o.tracking?.external_id || o.tracking?.pt_xid || customerId,
      purchase_event_id: o.tracking?.purchase_event_id ?? null,
      delivery: [],
    },
  };
}
