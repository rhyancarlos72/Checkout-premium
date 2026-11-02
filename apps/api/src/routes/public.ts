import crypto from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { clientIp, HttpError, must, productCode, supabase } from '../lib/core.js';
import { createOrder, createOrderSchema, renewOrder, deliveryItems, loadCheckout, quote, syncOrderWithProvider } from '../services/orders.js';
import { getSettings } from '../services/settings.js';
import { unsubscribe, unsubscribeSig } from '../services/email.js';

export const publicRouter = Router();

const orderLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Muitas tentativas. Aguarde alguns minutos.' } });
const quoteLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
const pollLimiter = rateLimit({ windowMs: 60 * 1000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false });
const eventLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });

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

publicRouter.get('/brand', async (_req, res) => {
  const { brand } = await getSettings();
  res.set('Cache-Control', 'no-cache');
  res.json(brand);
});

publicRouter.get('/checkouts/:slug', async (req, res) => {
  const c = await loadCheckout(String(req.params.slug));
  const s = await getSettings();
  // Sem cache: alterações no painel (bumps, preço, visual) aparecem na hora,
  // inclusive atrás do cache da hospedagem (LiteSpeed/Hostinger)
  res.set('Cache-Control', 'no-store, max-age=0');
  res.json({
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
    })),
    store: { name: s.store.name, supportEmail: s.store.supportEmail, document: s.store.document },
  });
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

publicRouter.post('/orders', orderLimiter, async (req, res) => {
  const input = createOrderSchema.parse(req.body);
  const result = await createOrder(input, { ip: clientIp(req as any), userAgent: req.get('user-agent') ?? null });
  res.status(201).json(result);
});

const tokenSchema = z.string().regex(/^[a-f0-9]{48}$/);

async function publicOrder(token: string) {
  const o: any = must(
    await supabase
      .from('orders')
      .select('id, number, status, customer_id, total_cents, subtotal_cents, discount_cents, pix_code, pix_qr_image, expires_at, paid_at, provider, created_at, customer:customers(name, email, phone), checkout:checkouts(slug, name, theme, tracking), items:order_items(kind, name, price_cents, product:products(number)), tracking')
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
    _id: o.id,
  };
}

publicRouter.get('/orders/:token', pollLimiter, async (req, res) => {
  const { _id, ...o } = await publicOrder(tokenSchema.parse(String(req.params.token)));
  res.set('Cache-Control', 'no-store');
  res.json(o);
});

/** Botão "Já paguei": força consulta ao gateway. */
/** Pix vencido: gera um novo Pix para a mesma compra, sem preencher nada. */
publicRouter.post('/orders/:token/renew', orderLimiter, async (req, res) => {
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
  const { data: c } = await supabase.from('checkouts').select('id').eq('slug', e.checkout_slug).maybeSingle();
  if (c) {
    const data = JSON.stringify(e.data).length <= 2000 ? e.data : {};
    await supabase.from('events').insert({ checkout_id: c.id, type: e.type, session_id: e.session_id ?? null, data });
  }
  res.status(204).end();
});
