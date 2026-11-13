import crypto from 'node:crypto';
import express, { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { geoTrackingFromIp } from '../services/geoip.js';
import { thumbHandler } from '../services/thumbs.js';
import { bumpIsRecurring, bumpMonthlyCents, subscriptionsAvailable } from '../services/subscriptions.js';
import { clientIp, geoFromHeaders, HttpError, must, productCode, supabase } from '../lib/core.js';
import { cardOptionFor, createOrder, createOrderSchema, createUpsellOrder, renewOrder, upsellOfferFor, deliveryItems, loadCheckout, quote, syncOrderWithProvider } from '../services/orders.js';
import { getSettings } from '../services/settings.js';
import { isOwnerOrg, ownerOrgId, runAsOrg } from '../lib/tenant.js';
import { unsubscribe, unsubscribeSig } from '../services/email.js';

export const publicRouter = Router();

// Limites antiabuso por COMPRADOR, não só por IP: no Brasil muitas operadoras de celular colocam
// milhares de clientes atrás do mesmo IP (CGNAT) e um limite só por IP bloquearia vendas reais.
const ipOf = (req: any) => ipKeyGenerator(clientIp(req) ?? req.ip ?? '0.0.0.0');
const rl = (windowMs: number, limit: number, key: (req: any) => string, message?: string) =>
  rateLimit({ windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: key, ...(message ? { message: { error: message } } : {}) });
const MSG = 'Muitas tentativas. Aguarde alguns minutos.';
const orderLimiter = rl(10 * 60 * 1000, 6, (req) => `${ipOf(req)}|${String(req.body?.customer?.email ?? '').trim().toLowerCase()}`, MSG); // mesmo comprador
const orderIpLimiter = rl(10 * 60 * 1000, 150, ipOf, MSG); // teto alto por IP (CGNAT)
const tokenLimiter = rl(10 * 60 * 1000, 10, (req) => `t|${req.params.token}`, MSG); // renovar/upsell por pedido
const quoteLimiter = rl(60 * 1000, 30, (req) => `${ipOf(req)}|${req.params.slug}|${String(req.headers['user-agent'] ?? '').slice(0, 60)}`);
const pollLimiter = rl(60 * 1000, 40, (req) => `${ipOf(req)}|${req.params.token}`); // consulta do status do Pix, por pedido
const eventLimiter = rl(60 * 1000, 300, ipOf);

// Marca do sistema (logo + nome) para a tela de login e o painel — só dados públicos
// Descadastro de e-mails de recuperação (link no rodapé + List-Unsubscribe de 1 clique)
const unsubHandler = async (req: any, res: any) => {
  const e = String(req.query.e ?? '').trim().toLowerCase();
  const sig = String(req.query.s ?? '');
  const valid = e.length > 3 && e.length < 200 && sig.length === 32 && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(unsubscribeSig(e)));
  if (valid) await unsubscribe(e);
  if (req.method === 'POST') return res.status(valid ? 200 : 400).end();
  res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>E-mails</title><body style="font-family:system-ui,sans-serif;max-width:480px;margin:60px auto;padding:0 16px;color:#111;text-align:center"><h1 style="font-size:20px">${valid ? 'Pronto, você não receberá mais esses e-mails.' : 'Link inválido.'}</h1><p style="color:#555">${valid ? 'Os e-mails de acesso a compras pagas continuam chegando normalmente.' : 'Use o link do rodapé do e-mail.'}</p></body>`);
};
publicRouter.get('/unsubscribe', unsubHandler);
publicRouter.post('/unsubscribe', unsubHandler);

// miniaturas das imagens do Storage (order bumps, produto): WebP pequeno, cache de 1 ano
publicRouter.get('/img', thumbHandler);

publicRouter.get('/brand', async (_req, res) => {
  const { brand } = await getSettings();
  res.set('Cache-Control', 'no-cache');
  res.json(brand);
});

/** Dados públicos do checkout (também embutidos no HTML da página para abrir sem esperar a API). */
export async function publicCheckoutData(slug: string) {
  // checkout e organização proprietária em paralelo (menos idas e voltas ao banco na primeira visita)
  const [c] = await Promise.all([loadCheckout(slug), ownerOrgId().catch(() => null)]);
  const s = await runAsOrg(c.org_id ?? null, () => getSettings()); // nome/CNPJ da loja do produtor dono do checkout
  const subsOn = c.bumps.some(bumpIsRecurring) && subscriptionsAvailable(await isOwnerOrg(c.org_id ?? null));
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    price_cents: c.price_cents,
    theme: c.theme,
    fields: c.fields,
    tracking: { metaPixelId: c.tracking?.metaPixelId ?? null },
    product: { name: c.product.name, number: c.product.number ?? null, description: c.product.description, image_url: c.product.image_url },
    bumps: c.bumps.map((b: any) => ({
      id: b.id,
      title: b.title,
      description: b.description,
      price_cents: b.price_cents,
      compare_at_cents: b.compare_at_cents,
      image_url: b.image_url,
      // assinatura mensal (Pix Automático): só aparece como assinatura quando está ligada em Integrações
      ...(subsOn && bumpIsRecurring(b) ? { recurring: true, monthly_cents: bumpMonthlyCents(b) } : {}),
    })),
    store: { name: s.store.name, supportEmail: s.store.supportEmail, document: s.store.document },
    // formas de pagamento além do Pix (cartão só quando liberado pelo Super Admin para este produtor)
    payment: { card: await cardOptionFor(c.org_id ?? null) },
  };
}

publicRouter.get('/checkouts/:slug', async (req, res) => {
  const data = await publicCheckoutData(String(req.params.slug));
  // Sem cache: alterações no painel (bumps, preço, visual) aparecem na hora,
  // inclusive atrás do cache da hospedagem (LiteSpeed/Hostinger)
  res.set('Cache-Control', 'no-store, max-age=0');
  res.json(data);
});

publicRouter.post('/checkouts/:slug/quote', quoteLimiter, async (req, res) => {
  const body = z
    .object({ bump_ids: z.array(z.string().uuid()).max(10).default([]), coupon_code: z.string().trim().toUpperCase().max(40).optional().nullable() })
    .parse(req.body);
  const q = await quote(String(req.params.slug), body.bump_ids, body.coupon_code);
  res.json({
    subtotal_cents: q.subtotalCents,
    discount_cents: q.discountCents,
    total_cents: q.totalCents,
    coupon: q.coupon ? { code: q.coupon.code } : null,
    coupon_error: q.couponError,
  });
});

publicRouter.post('/orders', orderIpLimiter, orderLimiter, async (req, res) => {
  const input = createOrderSchema.parse(req.body);
  const ip = clientIp(req as any);
  // cidade/estado: cabeçalhos da CDN quando houver; senão, pela base de IP do próprio servidor
  const result = await createOrder(input, { ip, userAgent: req.get('user-agent') ?? null, geo: { ...geoTrackingFromIp(ip), ...geoFromHeaders(req.headers as any) } });
  res.status(201).json(result);
});

const tokenSchema = z.string().regex(/^[a-f0-9]{48}$/);

async function subscriptionSummary(subId: string, recId: string | null) {
  const { data } = await supabase.from('subscriptions').select('price_cents, items, status, paid_until, rec_status').eq('id', subId).maybeSingle();
  const sub: any = data;
  if (!sub) return null;
  return { names: ((sub.items ?? []) as any[]).map((i) => i.name), monthly_cents: sub.price_cents, auto: Boolean(recId), authorized: sub.rec_status === 'APROVADA', paid_until: sub.paid_until ?? null };
}

/** Dados públicos do pedido (também embutidos no HTML da página do Pix). */
export async function publicOrder(token: string) {
  const o: any = must(
    await supabase
      .from('orders')
      .select('*, customer:customers(name, email, phone), checkout:checkouts(slug, name, theme, tracking), items:order_items(kind, name, price_cents, product_id, product:products(number))')
      .eq('public_token', token)
      .maybeSingle(),
    'Pedido não encontrado',
  );
  return {
    number: o.number,
    status: o.status,
    total_cents: o.total_cents,
    subtotal_cents: o.subtotal_cents,
    discount_cents: o.discount_cents,
    pix_code: o.status === 'pending' ? o.pix_code : null,
    pix_qr_image: o.status === 'pending' ? o.pix_qr_image : null,
    payment_method: o.payment_method ?? 'pix',
    card_url: o.status === 'pending' ? (o.card_checkout_url ?? null) : null,
    expires_at: o.expires_at,
    paid_at: o.paid_at,
    created_at: o.created_at,
    items: o.items.map((i: any) => ({ kind: i.kind, name: i.name, price_cents: i.price_cents })),
    external_id: o.tracking?.external_id || o.tracking?.pt_xid || o.customer_id || null,
    content_ids: o.items.map((i: any) => productCode(i.product?.number)).filter(Boolean),
    customer: o.customer,
    checkout: o.checkout ? { slug: o.checkout.slug, name: o.checkout.name, theme: o.checkout.theme, metaPixelId: o.checkout.tracking?.metaPixelId ?? null } : null,
    purchase_event_id: o.tracking?.purchase_event_id ?? null,
    delivery: o.status === 'paid' ? await deliveryItems(o.id) : [],
    // quem recebe o pagamento (dá segurança a quem vai pagar)
    store: await runAsOrg(o.org_id ?? null, () => getSettings()).then((st) => ({ name: st.store.pixReceiver || (st.store.name && st.store.name !== 'Minha Loja' ? st.store.name : null), document: st.store.document || null, supportEmail: st.store.supportEmail || null })).catch(() => null),
    upsell: o.status === 'paid' ? await upsellOfferFor(o).catch(() => null) : null,
    is_upsell: Boolean(o.tracking?.upsell_of),
    // assinatura mensal: a página explica a autorização do Pix Automático no app do banco
    subscription: o.subscription_id ? await subscriptionSummary(o.subscription_id, o.rec_id) : null,
    _id: o.id,
  };
}

publicRouter.get('/orders/:token', pollLimiter, async (req, res) => {
  const { _id, ...o } = await publicOrder(tokenSchema.parse(String(req.params.token)));
  res.set('Cache-Control', 'no-store');
  res.json(o);
});

/** Botão "Já paguei": força consulta ao gateway. */
/** Upsell aceito no popup: gera o Pix do produto oferecido, sem preencher nada. */
publicRouter.post('/orders/:token/upsell', tokenLimiter, async (req, res) => {
  const token = tokenSchema.parse(String(req.params.token));
  const r = await createUpsellOrder(token);
  const { _id, ...o } = await publicOrder(r.token);
  res.json({ token: r.token, order: o });
});
publicRouter.post('/orders/:token/upsell/decline', pollLimiter, async (req, res) => {
  const token = tokenSchema.parse(String(req.params.token));
  const { data } = await supabase.from('orders').select('id, checkout_id').eq('public_token', token).maybeSingle();
  if (data) await supabase.from('events').insert({ order_id: (data as any).id, checkout_id: (data as any).checkout_id, type: 'upsell_declined', data: {} });
  res.status(204).end();
});

/** Volta da verificação 3DS do banco (cartão Efí): o banco pode voltar com POST; leva para a página do pedido. */
const tdsReturn = (req: any, res: any) => {
  const token = String(req.params.token ?? '');
  if (!/^[a-f0-9]{48}$/.test(token)) return res.redirect(303, '/');
  res.redirect(303, `/pedido/${token}`);
};
publicRouter.get('/orders/:token/3ds-return', tdsReturn);
publicRouter.post('/orders/:token/3ds-return', express.urlencoded({ extended: false, limit: '20kb' }), tdsReturn);

/** Pix vencido: gera um novo Pix para a mesma compra, sem preencher nada. */
publicRouter.post('/orders/:token/renew', tokenLimiter, async (req, res) => {
  const token = tokenSchema.parse(String(req.params.token));
  const r = await renewOrder(token);
  const { _id, ...o } = await publicOrder(r.token);
  res.json({ token: r.token, renewed: r.renewed, order: o });
});

publicRouter.post('/orders/:token/refresh', pollLimiter, async (req, res) => {
  const token = tokenSchema.parse(String(req.params.token));
  const { data } = await supabase.from('orders').select('id, status').eq('public_token', token).maybeSingle();
  if (!data) throw new HttpError(404, 'Pedido não encontrado');
  if (data.status === 'pending') await syncOrderWithProvider(data.id);
  const { _id, ...o } = await publicOrder(token);
  res.json(o);
});

const eventSchema = z.object({
  checkout_slug: z.string().regex(/^[a-z0-9-]{3,60}$/),
  type: z.enum(['page_view', 'initiate_checkout', 'add_bump', 'remove_bump', 'coupon_applied', 'pix_copied', 'payment_page_view']),
  session_id: z.string().max(64).optional(),
  data: z.record(z.string(), z.unknown()).optional().default({}),
});

publicRouter.post('/events', eventLimiter, async (req, res) => {
  const e = eventSchema.parse(req.body);
  // id do checkout vem da memória (sem consultar o banco a cada evento)
  const c = await loadCheckout(e.checkout_slug).catch(() => null);
  if (c) {
    const data = JSON.stringify(e.data).length <= 2000 ? e.data : {};
    await supabase.from('events').insert({ checkout_id: c.id, type: e.type, session_id: e.session_id ?? null, data });
  }
  res.status(204).end();
});
