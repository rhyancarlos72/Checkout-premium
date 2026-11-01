import { Router } from 'express';
import { z } from 'zod';
import { env, features } from '../config/env.js';
import { HttpError, must, supabase } from '../lib/core.js';
import { requireAdmin } from '../middleware/auth.js';
import { efi, providerStatus } from '../providers/index.js';
import { testEmail } from '../services/email.js';
import { runJobs } from '../services/jobs.js';
import { dispatchTracking, resendDelivery, syncOrderWithProvider } from '../services/orders.js';
import { testPayTracking } from '../services/paytracking.js';
import { getSettings, saveSettings } from '../services/settings.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

const uuid = z.string().uuid();
const urlOrEmpty = z.string().url().or(z.literal('')).nullable().optional().transform((v) => v || null);

adminRouter.get('/me', (req, res) => res.json({ id: req.adminId, email: req.adminEmail }));

// ------------------------------------------------------------------ CRUD genérico
function crud<S extends z.ZodTypeAny>(path: string, table: string, schema: S, select = '*', order = 'created_at') {
  adminRouter.get(`/${path}`, async (_req, res) => {
    res.json(must(await supabase.from(table).select(select).order(order, { ascending: false })));
  });
  adminRouter.get(`/${path}/:id`, async (req, res) => {
    res.json(must(await supabase.from(table).select(select).eq('id', uuid.parse(req.params.id)).maybeSingle()));
  });
  adminRouter.post(`/${path}`, async (req, res) => {
    res.status(201).json(must(await supabase.from(table).insert(schema.parse(req.body)).select().single()));
  });
  adminRouter.put(`/${path}/:id`, async (req, res) => {
    const body = (schema as any).partial ? (schema as any).partial().parse(req.body) : schema.parse(req.body);
    res.json(must(await supabase.from(table).update(body).eq('id', uuid.parse(req.params.id)).select().single()));
  });
  adminRouter.delete(`/${path}/:id`, async (req, res) => {
    const { error } = await supabase.from(table).delete().eq('id', uuid.parse(req.params.id));
    if (error) throw new HttpError(409, error.code === '23503' ? 'Item em uso por outro registro (desative em vez de excluir)' : error.message);
    res.status(204).end();
  });
}

const productSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().max(2000).nullable().optional(),
  price_cents: z.number().int().min(1),
  image_url: urlOrEmpty,
  delivery_type: z.enum(['link', 'file', 'none']).default('link'),
  delivery_url: z.string().max(1000).nullable().optional(),
  delivery_note: z.string().max(1000).nullable().optional(),
  active: z.boolean().default(true),
});
crud('products', 'products', productSchema);

const bumpSchema = z.object({
  product_id: uuid,
  title: z.string().trim().min(2).max(120),
  description: z.string().max(600).nullable().optional(),
  price_cents: z.number().int().min(1),
  compare_at_cents: z.number().int().min(0).nullable().optional(),
  image_url: urlOrEmpty,
  active: z.boolean().default(true),
});
crud('bumps', 'order_bumps', bumpSchema, '*, product:products(name)');

const couponSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,40}$/, 'Use letras, números, _ ou -'),
  type: z.enum(['percent', 'fixed']),
  value: z.number().int().min(1),
  max_uses: z.number().int().min(1).nullable().optional(),
  min_cents: z.number().int().min(0).default(0),
  checkout_id: uuid.nullable().optional(),
  expires_at: z.string().datetime({ offset: true }).nullable().optional(),
  active: z.boolean().default(true),
});
crud('coupons', 'coupons', couponSchema, '*, checkout:checkouts(name)');

// ------------------------------------------------------------------ checkouts (com bumps)
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Cor inválida (use #RRGGBB)');
const themeSchema = z
  .object({
    mode: z.enum(['light', 'dark']).default('light'),
    primaryColor: hex.default('#059669'),
    backgroundColor: hex.default('#f4f5f7'),
    radius: z.enum(['sharp', 'soft', 'round']).default('soft'),
    headline: z.string().max(140).optional(),
    subheadline: z.string().max(400).optional(),
    buttonText: z.string().max(40).default('Finalizar compra'),
    logoUrl: urlOrEmpty,
    bannerUrl: urlOrEmpty,
    mockupUrl: urlOrEmpty,
    guaranteeDays: z.number().int().min(0).max(365).default(7),
    guaranteeText: z.string().max(400).optional(),
    testimonials: z.array(z.object({ name: z.string().max(60), text: z.string().max(400), avatarUrl: urlOrEmpty })).max(6).default([]),
    footerText: z.string().max(600).optional(),
    announcement: z.string().max(120).optional(),
    showTimer: z.boolean().default(false),
    timerMinutes: z.number().int().min(1).max(120).default(15),
    timerText: z.string().max(60).optional(),
    showSeals: z.boolean().default(true),
    stickyMobileCta: z.boolean().default(true),
  })
  .strip();

const checkoutSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{3,60}$/, 'Use letras minúsculas, números e hífen'),
  name: z.string().trim().min(2).max(120),
  product_id: uuid,
  provider: z.enum(['woovi', 'efi']),
  price_cents: z.number().int().min(1).nullable().optional(),
  theme: themeSchema.default({} as any),
  fields: z.object({ phone: z.boolean().default(true), document: z.boolean().default(true) }).default({ phone: true, document: true }),
  tracking: z.object({ metaPixelId: z.string().regex(/^\d{5,20}$/).or(z.literal('')).optional() }).default({}),
  pix_expires_minutes: z.number().int().min(5).max(1440).default(30),
  active: z.boolean().default(true),
  bump_ids: z.array(uuid).max(10).default([]),
});

const checkoutSelect = '*, product:products(name, price_cents), checkout_bumps(bump_id, sort)';

adminRouter.get('/checkouts', async (_req, res) => {
  res.json(must(await supabase.from('checkouts').select(checkoutSelect).order('created_at', { ascending: false })));
});
adminRouter.get('/checkouts/:id', async (req, res) => {
  res.json(must(await supabase.from('checkouts').select(checkoutSelect).eq('id', uuid.parse(req.params.id)).maybeSingle()));
});

async function saveBumps(checkoutId: string, ids: string[]) {
  await supabase.from('checkout_bumps').delete().eq('checkout_id', checkoutId);
  if (ids.length) await supabase.from('checkout_bumps').insert(ids.map((bump_id, sort) => ({ checkout_id: checkoutId, bump_id, sort })));
}

function slugConflict(e: { code?: string; message: string } | null) {
  if (e?.code === '23505') throw new HttpError(409, 'Já existe um checkout com este endereço (slug)');
  if (e) throw new HttpError(500, e.message);
}

adminRouter.post('/checkouts', async (req, res) => {
  const { bump_ids, ...data } = checkoutSchema.parse(req.body);
  const r = await supabase.from('checkouts').insert(data).select().single();
  slugConflict(r.error);
  await saveBumps(r.data!.id, bump_ids);
  res.status(201).json(r.data);
});
adminRouter.put('/checkouts/:id', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { bump_ids, ...data } = checkoutSchema.parse(req.body);
  const r = await supabase.from('checkouts').update(data).eq('id', id).select().single();
  slugConflict(r.error);
  await saveBumps(id, bump_ids);
  res.json(r.data);
});
adminRouter.delete('/checkouts/:id', async (req, res) => {
  const { error } = await supabase.from('checkouts').delete().eq('id', uuid.parse(req.params.id));
  if (error) throw new HttpError(409, error.message);
  res.status(204).end();
});

// ------------------------------------------------------------------ pedidos
const orderListQuery = z.object({
  status: z.enum(['pending', 'paid', 'expired', 'canceled', 'refunded', 'failed', 'all']).default('all'),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(5).max(100).default(25),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

function ordersQuery(f: z.infer<typeof orderListQuery>, select: string, count = true) {
  let q = supabase
    .from('orders')
    .select(select, count ? { count: 'exact' } : undefined)
    .order('created_at', { ascending: false });
  if (f.status !== 'all') q = q.eq('status', f.status);
  if (f.from) q = q.gte('created_at', f.from);
  if (f.to) q = q.lt('created_at', f.to);
  if (f.q) {
    const term = f.q.replace(/[%,()]/g, '');
    if (/^\d+$/.test(term)) q = q.eq('number', Number(term));
    else q = q.or(`email.ilike.%${term}%,name.ilike.%${term}%`, { referencedTable: 'customers' });
  }
  return q;
}

const orderListSelect = 'id, number, status, provider, total_cents, discount_cents, created_at, paid_at, tracking, customer:customers!inner(name, email, phone), checkout:checkouts(name, slug), items:order_items(kind, name, price_cents)';

adminRouter.get('/orders', async (req, res) => {
  const f = orderListQuery.parse(req.query);
  const sel = f.q && !/^\d+$/.test(f.q) ? orderListSelect : orderListSelect.replace('customers!inner', 'customers');
  const { data, error, count } = await ordersQuery(f, sel).range((f.page - 1) * f.pageSize, f.page * f.pageSize - 1);
  if (error) throw new HttpError(500, error.message);
  res.json({ data, total: count ?? 0, page: f.page, pageSize: f.pageSize });
});

adminRouter.get('/orders/export.csv', async (req, res) => {
  const f = orderListQuery.parse(req.query);
  const sel = f.q && !/^\d+$/.test(f.q) ? orderListSelect : orderListSelect.replace('customers!inner', 'customers');
  const { data, error } = await ordersQuery(f, sel, false).limit(5000);
  if (error) throw new HttpError(500, error.message);
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = (data as any[]).map((o) =>
    [o.number, o.created_at, o.status, o.provider, (o.total_cents / 100).toFixed(2).replace('.', ','), o.customer?.name, o.customer?.email, o.customer?.phone, o.checkout?.name, o.tracking?.utm_source, o.tracking?.utm_campaign, o.paid_at]
      .map(esc)
      .join(';'),
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="pedidos.csv"');
  res.send('﻿' + ['Pedido;Data;Status;Gateway;Total;Cliente;Email;Telefone;Checkout;utm_source;utm_campaign;Pago em', ...rows].join('\n'));
});

adminRouter.get('/orders/:id', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const order: any = must(
    await supabase
      .from('orders')
      .select('*, customer:customers(*), checkout:checkouts(name, slug), coupon:coupons(code), items:order_items(*)')
      .eq('id', id)
      .maybeSingle(),
  );
  const [logs, events] = await Promise.all([
    supabase.from('integration_logs').select('*').eq('order_id', id).order('created_at', { ascending: false }).limit(50),
    supabase.from('events').select('*').eq('order_id', id).order('created_at', { ascending: false }).limit(50),
  ]);
  res.json({ ...order, logs: logs.data ?? [], events: events.data ?? [] });
});

adminRouter.post('/orders/:id/sync', async (req, res) => {
  res.json({ result: await syncOrderWithProvider(uuid.parse(req.params.id)) });
});
adminRouter.post('/orders/:id/resend-delivery', async (req, res) => {
  await resendDelivery(uuid.parse(req.params.id));
  res.json({ ok: true });
});
adminRouter.post('/orders/:id/refund', async (req, res) => {
  // Marca como reembolsado no sistema (o estorno do PIX é feito no painel do gateway)
  const id = uuid.parse(req.params.id);
  const { data } = await supabase.from('orders').update({ status: 'refunded' }).eq('id', id).eq('status', 'paid').select('id');
  if (!data?.length) throw new HttpError(400, 'Só pedidos pagos podem ser marcados como reembolsados');
  void dispatchTracking(id, 'sale.refunded');
  res.json({ ok: true });
});
adminRouter.post('/orders/:id/resend-tracking', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { data } = await supabase.from('orders').select('status').eq('id', id).maybeSingle();
  if (!data) throw new HttpError(404, 'Pedido não encontrado');
  const map: Record<string, any> = { paid: 'sale.approved', pending: 'sale.pending', refunded: 'sale.refunded', expired: 'sale.canceled', canceled: 'sale.canceled' };
  if (!map[data.status]) throw new HttpError(400, 'Status sem evento correspondente');
  await dispatchTracking(id, map[data.status]);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ clientes
adminRouter.get('/customers', async (req, res) => {
  const q = z.object({ q: z.string().trim().max(100).optional(), page: z.coerce.number().int().min(1).default(1) }).parse(req.query);
  const pageSize = 30;
  let query = supabase
    .from('customers')
    .select('id, name, email, phone, document, created_at, orders(status, total_cents, created_at)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((q.page - 1) * pageSize, q.page * pageSize - 1);
  if (q.q) {
    const t = q.q.replace(/[%,()]/g, '');
    query = query.or(`email.ilike.%${t}%,name.ilike.%${t}%,phone.ilike.%${t}%`);
  }
  const { data, error, count } = await query;
  if (error) throw new HttpError(500, error.message);
  res.json({
    data: (data as any[]).map(({ orders, document, ...c }) => ({
      ...c,
      document: document ? `***${String(document).slice(-4)}` : null,
      orders_count: orders.length,
      paid_count: orders.filter((o: any) => o.status === 'paid').length,
      total_spent_cents: orders.filter((o: any) => o.status === 'paid').reduce((s: number, o: any) => s + o.total_cents, 0),
      last_order_at: orders.map((o: any) => o.created_at).sort().at(-1) ?? null,
    })),
    total: count ?? 0,
    page: q.page,
    pageSize,
  });
});

// ------------------------------------------------------------------ dashboard
adminRouter.get('/dashboard', async (req, res) => {
  const days = z.coerce.number().int().min(1).max(365).default(30).parse(req.query.days);
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  const prevFrom = new Date(from.getTime() - days * 86400000);

  const [series, current, previous, events, topItems] = await Promise.all([
    supabase.rpc('sales_by_day', { p_from: from.toISOString(), p_to: to.toISOString() }),
    supabase.from('orders').select('status, total_cents, provider').gte('created_at', from.toISOString()),
    supabase.from('orders').select('status, total_cents').gte('created_at', prevFrom.toISOString()).lt('created_at', from.toISOString()),
    supabase.from('events').select('type').gte('created_at', from.toISOString()).in('type', ['page_view', 'initiate_checkout']).limit(100000),
    supabase.from('order_items').select('name, kind, price_cents, order:orders!inner(status, created_at)').eq('order.status', 'paid').gte('order.created_at', from.toISOString()).limit(10000),
  ]);

  const agg = (rows: any[] | null) => {
    const paid = (rows ?? []).filter((r) => r.status === 'paid');
    const revenue = paid.reduce((s, r) => s + r.total_cents, 0);
    return { orders: rows?.length ?? 0, paid: paid.length, revenue_cents: revenue, avg_ticket_cents: paid.length ? Math.round(revenue / paid.length) : 0 };
  };
  const cur = agg(current.data);
  const prev = agg(previous.data);
  const pending = (current.data ?? []).filter((r: any) => r.status === 'pending');
  const ev = (events.data ?? []).reduce<Record<string, number>>((m, e: any) => ((m[e.type] = (m[e.type] ?? 0) + 1), m), {});

  const top = new Map<string, { name: string; kind: string; count: number; revenue_cents: number }>();
  for (const it of (topItems.data ?? []) as any[]) {
    const k = `${it.kind}:${it.name}`;
    const t = top.get(k) ?? { name: it.name, kind: it.kind, count: 0, revenue_cents: 0 };
    t.count++;
    t.revenue_cents += it.price_cents;
    top.set(k, t);
  }
  const bumpsSold = [...top.values()].filter((t) => t.kind === 'bump').reduce((s, t) => s + t.count, 0);

  res.json({
    period: { from, to, days },
    kpis: {
      ...cur,
      pending_count: pending.length,
      pending_cents: pending.reduce((s: number, r: any) => s + r.total_cents, 0),
      conversion_pix: cur.orders ? cur.paid / cur.orders : 0,
      bump_take_rate: cur.paid ? bumpsSold / cur.paid : 0,
      previous: prev,
    },
    funnel: { page_view: ev.page_view ?? 0, initiate_checkout: ev.initiate_checkout ?? 0, pix_generated: cur.orders, paid: cur.paid },
    series: series.data ?? [],
    top_products: [...top.values()].sort((a, b) => b.revenue_cents - a.revenue_cents).slice(0, 8),
  });
});

// ------------------------------------------------------------------ integrações
adminRouter.get('/integrations', async (_req, res) => {
  const lastWebhooks = await supabase.from('webhook_logs').select('provider, status, error, reference, created_at').order('created_at', { ascending: false }).limit(20);
  const lastLogs = await supabase.from('integration_logs').select('integration, event, ok, http_status, message, created_at').order('created_at', { ascending: false }).limit(20);
  res.json({
    providers: providerStatus(),
    paytracking: { configured: features.paytracking, signed: Boolean(env.PAYTRACKING_SECRET) },
    email: { configured: features.email, from: env.MAIL_FROM ?? null },
    webhooks: {
      woovi: `${env.PUBLIC_URL}/api/webhooks/woovi`,
      wooviSecretConfigured: Boolean(env.WOOVI_WEBHOOK_SECRET),
      efi: `${env.PUBLIC_URL}/api/webhooks/efi`,
      efiSecretConfigured: Boolean(env.EFI_WEBHOOK_SECRET),
      efiSandbox: env.EFI_SANDBOX,
    },
    jobs: { enabled: env.JOBS_ENABLED },
    lastWebhooks: lastWebhooks.data ?? [],
    lastLogs: lastLogs.data ?? [],
  });
});

adminRouter.post('/integrations/paytracking/test', async (_req, res) => res.json(await testPayTracking()));
adminRouter.post('/integrations/email/test', async (req, res) => {
  const to = z.object({ to: z.string().email() }).parse(req.body).to;
  res.json(await testEmail(to));
});
adminRouter.post('/integrations/efi/register-webhook', async (_req, res) => {
  if (!efi.isConfigured()) throw new HttpError(400, 'Configure as variáveis EFI_* primeiro');
  if (!env.EFI_WEBHOOK_SECRET) throw new HttpError(400, 'Defina EFI_WEBHOOK_SECRET antes de registrar o webhook');
  const url = `${env.PUBLIC_URL}/api/webhooks/efi?hmac=${encodeURIComponent(env.EFI_WEBHOOK_SECRET)}&ignorar=`;
  await efi.registerWebhook(url);
  res.json({ ok: true, message: 'Webhook registrado na Efí' });
});
adminRouter.get('/integrations/efi/webhook', async (_req, res) => {
  const w = await efi.getWebhook();
  // não devolve o segredo ao navegador
  res.json({ webhookUrl: String(w?.webhookUrl ?? '').replace(/hmac=[^&]+/, 'hmac=***'), criacao: w?.criacao });
});
adminRouter.post('/jobs/run', async (_req, res) => {
  await runJobs();
  res.json({ ok: true });
});

adminRouter.get('/settings', async (_req, res) => res.json(await getSettings()));
adminRouter.put('/settings', async (req, res) => res.json(await saveSettings(req.body)));
