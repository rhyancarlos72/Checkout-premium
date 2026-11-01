import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { HttpError, must, supabase } from '../lib/core.js';
import { createOrder, createOrderSchema, deliveryItems, loadCheckout, quote, syncOrderWithProvider } from '../services/orders.js';
import { getSettings } from '../services/settings.js';

export const publicRouter = Router();

const orderLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 8, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Muitas tentativas. Aguarde alguns minutos.' } });
const quoteLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
const pollLimiter = rateLimit({ windowMs: 60 * 1000, limit: 40, standardHeaders: 'draft-8', legacyHeaders: false });
const eventLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false });

publicRouter.get('/checkouts/:slug', async (req, res) => {
  const c = await loadCheckout(String(req.params.slug));
  const s = await getSettings();
  res.set('Cache-Control', 'public, max-age=30');
  res.json({
    id: c.id,
    slug: c.slug,
    name: c.name,
    price_cents: c.price_cents,
    theme: c.theme,
    fields: c.fields,
    tracking: { metaPixelId: c.tracking?.metaPixelId ?? null },
    product: { name: c.product.name, description: c.product.description, image_url: c.product.image_url },
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
  const result = await createOrder(input, { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null });
  res.status(201).json(result);
});

const tokenSchema = z.string().regex(/^[a-f0-9]{48}$/);

async function publicOrder(token: string) {
  const o: any = must(
    await supabase
      .from('orders')
      .select('id, number, status, total_cents, subtotal_cents, discount_cents, pix_code, pix_qr_image, expires_at, paid_at, provider, created_at, customer:customers(name, email, phone), checkout:checkouts(slug, name, theme, tracking), items:order_items(kind, name, price_cents), tracking')
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
    items: o.items,
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
