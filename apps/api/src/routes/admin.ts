import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { env, features, isProd } from '../config/env.js';
import { HttpError, must, productCode, supabase } from '../lib/core.js';
import { clearAuthCache, requireAdmin, requireOwner } from '../middleware/auth.js';
import { emitInvoice, getInvoiceSettings, invoiceFile, refreshInvoice, saveInvoiceSettings, testSpedy } from '../services/invoices.js';
import { efi, providerStatus, woovi } from '../providers/index.js';
import { efiConfig, mask as gwMask, patchGateways, randomSecret, refreshGateways, validatePfx, wooviConfig } from '../services/gateways.js';
import { RECOVERY_ORDER_SELECT, sendRecoveryForOrder, testEmail } from '../services/email.js';
import { runJobs } from '../services/jobs.js';
import { clearCheckoutCache, dispatchTracking, resendDelivery, syncOrderWithProvider } from '../services/orders.js';
import { testPayTracking, testWebhook } from '../services/paytracking.js';
import { lastJobRunAt } from '../services/jobs.js';
import { buildApprovedMessage, buildRecoveryMessage, diagnoseWhatsApp, evolutionConnectStatus, evolutionCreateInstance, fetchEvolutionInstances, getWhatsAppConfig, instancesStatus, normalizePhoneBR, saveWhatsAppConfig, sendWhatsAppText, whatsappSchema } from '../services/whatsapp.js';
import { allWebhooks, listWebhooks, mask, newWebhookId, saveWebhooks, WEBHOOK_EVENTS, type Webhook } from '../services/webhooks.js';
import { getSettings, saveSettings } from '../services/settings.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);
// integrações e credenciais (Woovi, Efí, Evolution/WhatsApp, webhooks) e equipe: somente o dono
export const OWNER_ONLY_PATH = /^\/(gateways|integrations|whatsapp|webhooks|team)(\/|$)/i;
adminRouter.use((req, res, next) => (OWNER_ONLY_PATH.test(req.path) ? requireOwner(req, res, next) : next()));
// qualquer alteração no painel invalida o cache dos checkouts públicos
adminRouter.use((req, _res, next) => {
  if (req.method !== 'GET') clearCheckoutCache();
  next();
});

const uuid = z.string().uuid();
const urlOrEmpty = z.string().url().or(z.literal('')).nullable().optional().transform((v) => v || null);

adminRouter.get('/me', async (req, res) => {
  const { globalProvider } = await import('../services/gateways.js');
  res.json({ id: req.adminId, email: req.adminEmail, role: req.adminRole ?? 'staff', defaultProvider: globalProvider() });
});

// ------------------------------------------------------------------ equipe (somente o dono)
async function authUser(id: string) {
  const { data } = await supabase.auth.admin.getUserById(id);
  return data.user;
}
adminRouter.get('/team', async (_req, res) => {
  const { data, error } = await supabase.from('admins').select('*').order('created_at');
  if (error) throw new HttpError(500, error.message);
  const rows = await Promise.all(
    (data ?? []).map(async (a: any) => {
      const u = await authUser(a.user_id);
      const email = (u?.email ?? a.email ?? '').toLowerCase();
      const owner = env.ADMIN_EMAIL ? email === env.ADMIN_EMAIL : a.role !== 'staff';
      return { user_id: a.user_id, email, name: (u?.user_metadata?.full_name as string) ?? '', role: owner ? 'owner' : 'staff', created_at: a.created_at, last_sign_in_at: u?.last_sign_in_at ?? null };
    }),
  );
  res.json(rows);
});
adminRouter.post('/team', async (req, res) => {
  const { email } = z.object({ email: z.string().trim().toLowerCase().email('E-mail inválido') }).parse(req.body);
  if (email === req.adminEmail?.toLowerCase() || email === env.ADMIN_EMAIL) throw new HttpError(400, 'Este e-mail já é o dono da conta');
  const redirectTo = `${env.PUBLIC_URL}/admin/nova-senha`;
  let userId: string | null = null;
  const invited = await supabase.auth.admin.inviteUserByEmail(email, { redirectTo });
  if (invited.data?.user) userId = invited.data.user.id;
  else {
    // já tem conta: localiza e manda link para definir a senha
    for (let page = 1; page <= 20 && !userId; page++) {
      const { data } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
      userId = data?.users.find((u) => u.email?.toLowerCase() === email)?.id ?? null;
      if (!data || data.users.length < 200) break;
    }
    if (!userId) throw new HttpError(502, `Não foi possível convidar: ${invited.error?.message ?? 'erro'}`);
    await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  }
  let r = await supabase.from('admins').upsert({ user_id: userId, role: 'staff', email });
  if (r.error && /role|email/.test(r.error.message)) throw new HttpError(400, 'Rode no Supabase o SQL "20261105000000_admin_roles.sql" antes de adicionar pessoas à equipe');
  if (r.error) throw new HttpError(500, r.error.message);
  clearAuthCache();
  res.json({ ok: true, message: `Convite enviado para ${email}. A pessoa define a senha pelo link do e-mail.` });
});
adminRouter.delete('/team/:userId', async (req, res) => {
  const id = uuid.parse(req.params.userId);
  if (id === req.adminId) throw new HttpError(400, 'Você não pode remover a si mesmo');
  const u = await authUser(id);
  if (env.ADMIN_EMAIL && u?.email?.toLowerCase() === env.ADMIN_EMAIL) throw new HttpError(400, 'O dono da conta não pode ser removido');
  const { error } = await supabase.from('admins').delete().eq('user_id', id);
  if (error) throw new HttpError(500, error.message);
  clearAuthCache();
  res.status(204).end();
});

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
// Cada produto tem seu link de checkout com um CÓDIGO próprio (ex.: /checkout?produto_id=9452229),
// criado automaticamente junto com o produto.
/** Código numérico aleatório de 7 dígitos (ex.: 9452229) usado em /checkout?produto_id=… — não revela o nome do produto. */
function linkCode() {
  return String(crypto.randomInt(1_000_000, 10_000_000));
}

type CheckoutTemplate = { theme?: unknown; fields?: unknown; tracking?: unknown; provider?: string; price_cents?: number | null; pix_expires_minutes?: number; bumpIds?: string[] };

async function createDefaultCheckout(product: { id: string; name: string; number?: number | null }, template: CheckoutTemplate = {}) {
  const provider = template.provider ?? (woovi.isConfigured() ? 'woovi' : efi.isConfigured() ? 'efi' : 'woovi');
  for (let i = 0; i < 8; i++) {
    const r = await supabase
      .from('checkouts')
      .insert({
        // 1ª tentativa: o próprio ID do produto (link ?produto_id= igual ao ID); depois, código aleatório
        slug: i === 0 && product.number ? productCode(product.number) : linkCode(),
        name: product.name,
        product_id: product.id,
        provider,
        price_cents: template.price_cents ?? null,
        pix_expires_minutes: template.pix_expires_minutes ?? 30,
        fields: template.fields ?? { phone: true, document: false },
        theme: template.theme ?? {},
        tracking: template.tracking ?? {},
      })
      .select('id, slug')
      .single();
    if (!r.error) {
      if (template.bumpIds?.length) await saveBumps(r.data.id, template.bumpIds);
      return r.data;
    }
    if (r.error.code !== '23505') throw new HttpError(500, r.error.message);
  }
  throw new HttpError(500, 'Não foi possível gerar um código único');
}

adminRouter.post('/products', async (req, res) => {
  const product = must(await supabase.from('products').insert(productSchema.parse(req.body)).select().single()) as any;
  const checkout = await createDefaultCheckout(product);
  res.status(201).json({ ...product, checkout });
});
adminRouter.post('/products/:id/checkout', async (req, res) => {
  const product = must(await supabase.from('products').select('id, name, number').eq('id', uuid.parse(req.params.id)).maybeSingle(), 'Produto não encontrado') as any;
  res.status(201).json(await createDefaultCheckout(product));
});

// ------------------------------------------------------------------ produtos adicionais (order bumps) do produto principal
const productBumpsSchema = z.object({
  items: z
    .array(
      z.object({
        product_id: uuid,
        price_cents: z.number().int().min(1),
        compare_at_cents: z.number().int().min(0).nullable().optional(),
        title: z.string().trim().max(120).optional(),
        description: z.string().max(600).nullable().optional(),
      }),
    )
    .max(10),
});

// ------------------------------------------------------------------ upsell pós-compra (1 por produto principal)
const upsellSchema = z.object({
  offer_product_id: z.string().uuid('Escolha o produto oferecido'),
  headline: z.string().trim().max(120).optional().nullable(),
  title: z.string().trim().max(120).optional().nullable(),
  description: z.string().trim().max(600).optional().nullable(),
  image_url: urlOrEmpty,
  price_cents: z.number().int().min(100, 'Preço mínimo de R$ 1,00').max(100_000_00),
  compare_at_cents: z.number().int().min(0).max(100_000_00).optional().nullable(),
  cta_text: z.string().trim().max(80).optional().nullable(),
  active: z.boolean().default(true),
});
adminRouter.get('/upsells', async (_req, res) => {
  const { data, error } = await supabase.from('upsells').select('*, offer:products!upsells_offer_product_id_fkey(name, image_url, price_cents)').order('created_at');
  if (error) throw new HttpError(500, /relation|does not exist|schema cache/i.test(error.message) ? 'Rode no Supabase o SQL 20261107000000_upsells.sql' : error.message);
  res.json(data ?? []);
});
adminRouter.put('/products/:id/upsell', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = upsellSchema.parse(req.body);
  if (b.offer_product_id === id) throw new HttpError(400, 'Ofereça um produto diferente do principal');
  const { data, error } = await supabase
    .from('upsells')
    .upsert({ product_id: id, ...b, compare_at_cents: b.compare_at_cents || null, updated_at: new Date().toISOString() }, { onConflict: 'product_id' })
    .select()
    .single();
  if (error) throw new HttpError(500, error.message);
  res.json(data);
});
adminRouter.delete('/products/:id/upsell', async (req, res) => {
  await supabase.from('upsells').delete().eq('product_id', uuid.parse(req.params.id));
  res.status(204).end();
});

/** Produtos adicionais oferecidos junto com este produto (via checkouts dele). */
adminRouter.get('/products/:id/bumps', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { data } = await supabase
    .from('checkouts')
    .select('id, checkout_bumps(sort, bump:order_bumps(id, product_id, title, description, price_cents, compare_at_cents, image_url, active, product:products(name, price_cents, image_url)))')
    .eq('product_id', id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const items = [...(((data as any)?.checkout_bumps ?? []) as any[])].sort((a, b) => a.sort - b.sort).map((cb) => cb.bump).filter(Boolean);
  res.json(items);
});

/**
 * Define os produtos adicionais do produto principal: cria/atualiza um order bump
 * por produto oferecido e aplica a lista (na ordem) em TODOS os checkouts do produto.
 */
adminRouter.put('/products/:id/bumps', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { items } = productBumpsSchema.parse(req.body);
  if (items.some((i) => i.product_id === id)) throw new HttpError(400, 'O produto principal não pode ser oferecido como adicional dele mesmo');
  if (new Set(items.map((i) => i.product_id)).size !== items.length) throw new HttpError(400, 'Produto adicional repetido');

  const offered = items.length
    ? ((must(await supabase.from('products').select('id, name, description, image_url').in('id', items.map((i) => i.product_id))) as any[]) ?? [])
    : [];
  const { data: checkouts } = await supabase.from('checkouts').select('id, checkout_bumps(bump:order_bumps(id, product_id))').eq('product_id', id);
  if (!checkouts?.length) throw new HttpError(400, 'Gere o link de checkout deste produto primeiro');

  // reaproveita os bumps já ligados a este produto principal (mesmo produto oferecido)
  const existing = new Map<string, string>();
  for (const c of checkouts as any[]) for (const cb of c.checkout_bumps ?? []) if (cb.bump) existing.set(cb.bump.product_id, cb.bump.id);

  const bumpIds: string[] = [];
  for (const it of items) {
    const p = offered.find((o) => o.id === it.product_id);
    if (!p) throw new HttpError(400, 'Produto adicional não encontrado');
    const row = {
      product_id: it.product_id,
      title: it.title || `Leve também: ${p.name}`,
      description: it.description ?? p.description ?? null,
      price_cents: it.price_cents,
      compare_at_cents: it.compare_at_cents ?? null,
      image_url: p.image_url ?? null,
      active: true,
    };
    const prevId = existing.get(it.product_id);
    const r = prevId
      ? await supabase.from('order_bumps').update(row).eq('id', prevId).select('id').single()
      : await supabase.from('order_bumps').insert(row).select('id').single();
    if (r.error) throw new HttpError(500, r.error.message);
    bumpIds.push(r.data.id);
  }
  for (const c of checkouts as any[]) await saveBumps(c.id, bumpIds);
  res.json({ ok: true, count: bumpIds.length });
});

/** Duplica o produto e o checkout principal dele (visual, campos e order bumps), com novo código de link. */
adminRouter.post('/products/:id/duplicate', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const src = must(await supabase.from('products').select('*').eq('id', id).maybeSingle(), 'Produto não encontrado') as any;
  const { id: _id, number: _n, created_at: _c, updated_at: _u, ...data } = src;
  const copy = must(await supabase.from('products').insert({ ...data, name: `${src.name} (cópia)`.slice(0, 120) }).select().single()) as any;
  const { data: ck } = await supabase
    .from('checkouts')
    .select('theme, fields, tracking, provider, price_cents, pix_expires_minutes, checkout_bumps(bump_id, sort)')
    .eq('product_id', id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const tpl: CheckoutTemplate = ck
    ? { ...(ck as any), bumpIds: [...((ck as any).checkout_bumps ?? [])].sort((a: any, b: any) => a.sort - b.sort).map((b: any) => b.bump_id) }
    : {};
  const checkout = await createDefaultCheckout(copy, tpl);
  res.status(201).json({ ...copy, checkout });
});
crud('products', 'products', productSchema, '*, checkouts(id, slug, name, active, created_at, checkout_bumps(sort, bump:order_bumps(id, product_id, title, price_cents)))', 'created_at');

const bumpSchema = z.object({
  product_id: uuid,
  title: z.string().trim().min(2).max(120),
  description: z.string().max(600).nullable().optional(),
  price_cents: z.number().int().min(1),
  compare_at_cents: z.number().int().min(0).nullable().optional(),
  image_url: urlOrEmpty,
  active: z.boolean().default(true),
});
crud('bumps', 'order_bumps', bumpSchema, '*, product:products(name, number)');

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
    mode: z.enum(['light', 'dark', 'auto']).default('light'),
    primaryColor: hex.default('#059669'),
    backgroundColor: hex.default('#f4f5f7'),
    radius: z.enum(['sharp', 'soft', 'round']).default('soft'),
    headline: z.string().max(140).optional(),
    subheadline: z.string().max(400).optional(),
    producerName: z.string().max(80).optional(),
    compareAtCents: z.number().int().min(0).nullable().optional(),
    benefits: z.array(z.string().max(120)).max(8).default([]),
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
  fields: z.object({ phone: z.boolean().default(true), document: z.boolean().default(false) }).default({ phone: true, document: false }),
  tracking: z.object({ metaPixelId: z.string().regex(/^\d{5,20}$/).or(z.literal('')).optional() }).default({}),
  pix_expires_minutes: z.number().int().min(5).max(1440).default(30),
  active: z.boolean().default(true),
  bump_ids: z.array(uuid).max(10).default([]),
});

const checkoutSelect = '*, product:products(name, price_cents, number), checkout_bumps(bump_id, sort)';

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

const orderListSelect = 'id, number, status, provider, total_cents, discount_cents, created_at, paid_at, recovery_sent_at, tracking, customer:customers!inner(name, email, phone), checkout:checkouts(name, slug), items:order_items(kind, name, price_cents, product:products(number))';

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
    [o.number, o.created_at, o.status, o.provider, (o.total_cents / 100).toFixed(2).replace('.', ','), o.items.map((i: any) => `${i.product?.number ? `#${i.product.number} ` : ''}${i.name}`).join(' + '), o.customer?.name, o.customer?.email, o.customer?.phone, o.checkout?.name, o.tracking?.utm_source, o.tracking?.utm_campaign, o.paid_at]
      .map(esc)
      .join(';'),
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="pedidos.csv"');
  res.send('﻿' + ['Pedido;Data;Status;Gateway;Total;Produtos (ID);Cliente;Email;Telefone;Checkout;utm_source;utm_campaign;Pago em', ...rows].join('\n'));
});

adminRouter.get('/orders/:id', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const order: any = must(
    await supabase
      .from('orders')
      .select('*, customer:customers(*), checkout:checkouts(name, slug), coupon:coupons(code), items:order_items(*, product:products(number))')
      .eq('id', id)
      .maybeSingle(),
  );
  const [logs, events] = await Promise.all([
    supabase.from('integration_logs').select('*').eq('order_id', id).order('created_at', { ascending: false }).limit(50),
    supabase.from('events').select('*').eq('order_id', id).order('created_at', { ascending: false }).limit(50),
  ]);
  const { data: invoice } = await supabase.from('invoices').select('type, status, number, message, amount_cents, attempts, created_at, updated_at, provider_id').eq('order_id', id).maybeSingle();
  res.json({ ...order, invoice: invoice ?? null, logs: logs.data ?? [], events: events.data ?? [] });
});

adminRouter.post('/orders/:id/sync', async (req, res) => {
  res.json({ result: await syncOrderWithProvider(uuid.parse(req.params.id)) });
});
adminRouter.post('/orders/:id/resend-delivery', async (req, res) => {
  await resendDelivery(uuid.parse(req.params.id));
  res.json({ ok: true });
});
/** Recuperação manual por e-mail (ícone ao lado do status, só pedidos pendentes). */
adminRouter.post('/orders/:id/recovery-email', async (req, res) => {
  const id = uuid.parse(req.params.id);
  if (!features.email) return res.json({ ok: false, message: 'Configure o SMTP (variáveis SMTP_*) para enviar e-mails de recuperação' });
  const { data: o }: any = await supabase
    .from('orders')
    .select(RECOVERY_ORDER_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (!o) throw new HttpError(404, 'Pedido não encontrado');
  if (o.status !== 'pending' && o.status !== 'expired') throw new HttpError(400, 'Só pedidos pendentes recebem recuperação');
  if (!o.customer?.email || !o.checkout) throw new HttpError(400, 'Pedido sem e-mail do cliente');
  const ok = await sendRecoveryForOrder(o);
  if (!ok) {
    // mostra o motivo real (ex.: senha do SMTP recusada, cliente descadastrado)
    const { data: last } = await supabase.from('integration_logs').select('message').eq('order_id', id).eq('integration', 'email').eq('event', 'recovery').order('created_at', { ascending: false }).limit(1).maybeSingle();
    const why = String((last as any)?.message ?? '');
    const hint = /auth|535|credentials|password|login/i.test(why) ? ' Confira SMTP_USER e SMTP_PASS (senha do e-mail na Hostinger).' : /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timeout/i.test(why) ? ' Confira SMTP_HOST=smtp.hostinger.com e SMTP_PORT=465.' : '';
    return res.json({ ok: false, message: `E-mail não enviado${why ? `: ${why}` : ''}.${hint}` });
  }
  const sentAt = new Date().toISOString();
  await supabase.from('orders').update({ recovery_sent_at: sentAt }).eq('id', id);
  res.json({ ok: true, message: `E-mail de recuperação enviado para ${o.customer.email}`, sent_at: sentAt });
});

// ------------------------------------------------------------------ nota fiscal do pedido (Spedy)
adminRouter.post('/orders/:id/invoice', async (req, res) => {
  res.json(await emitInvoice(uuid.parse(req.params.id), { retry: true, manual: true }));
});
adminRouter.post('/orders/:id/invoice/refresh', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { data } = await supabase.from('invoices').select('type, provider_id').eq('order_id', id).maybeSingle();
  if (!(data as any)?.provider_id) throw new HttpError(400, 'Nota ainda não foi criada na Spedy');
  const st = await refreshInvoice(id, (data as any).type, (data as any).provider_id);
  res.json({ ok: Boolean(st), message: st ? `Status atualizado: ${({ issued: 'emitida', processing: 'em processamento', error: 'com erro', canceled: 'cancelada' } as any)[st]}` : 'Não foi possível consultar a Spedy' });
});
adminRouter.get('/orders/:id/invoice/:kind', async (req, res) => {
  const kind = z.enum(['pdf', 'xml']).parse(req.params.kind);
  const f = await invoiceFile(uuid.parse(req.params.id), kind);
  if (!f) throw new HttpError(404, 'Arquivo da nota ainda não disponível');
  res.setHeader('Content-Type', f.type);
  res.setHeader('Content-Disposition', `attachment; filename="nota-fiscal.${kind}"`);
  res.send(f.body);
});

// configuração da Spedy (somente o dono: rota em /integrations)
adminRouter.get('/integrations/invoices', async (_req, res) => {
  const s = await getInvoiceSettings();
  res.json({ ...s, apiKey: '', apiKey_hint: gwMask(s.apiKey), has_apiKey: Boolean(s.apiKey) });
});
adminRouter.put('/integrations/invoices', async (req, res) => {
  try {
    await saveInvoiceSettings(req.body);
  } catch (e: any) {
    if (e?.status === 400) throw new HttpError(400, e.message);
    throw e;
  }
  res.json({ ok: true });
});
adminRouter.post('/integrations/invoices/test', async (req, res) => res.json(await testSpedy(req.body ?? {})));
adminRouter.get('/integrations/invoices/list', async (_req, res) => {
  const { data, error } = await supabase.from('invoices').select('order_id, type, status, number, message, amount_cents, updated_at, order:orders(number, customer:customers(name))').order('created_at', { ascending: false }).limit(30);
  if (error) throw new HttpError(500, error.message);
  res.json(data ?? []);
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
const TZ = 'America/Sao_Paulo';
const hourFmt = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' });
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

adminRouter.get('/dashboard', async (req, res) => {
  const q = z
    .object({
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
      days: z.coerce.number().int().min(1).max(365).optional(),
      product_id: uuid.optional(),
    })
    .parse(req.query);
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - (q.days ?? 30) * 86400000);
  if (to.getTime() - from.getTime() > 366 * 86400000) throw new HttpError(400, 'Período máximo: 1 ano');

  const [ordersRes, productsRes] = await Promise.all([
    supabase
      .from('orders')
      .select('id, status, total_cents, provider, created_at, paid_at, recovery_sent_at, checkout_id, items:order_items(kind, product_id, name, price_cents, product:products(number))')
      .gte('created_at', from.toISOString())
      .lt('created_at', to.toISOString())
      .limit(50000),
    supabase.from('products').select('id, name, number, checkouts(id)').order('created_at', { ascending: false }),
  ]);
  if (ordersRes.error) throw new HttpError(500, ordersRes.error.message);

  const products = (productsRes.data ?? []) as any[];
  const checkoutIds = q.product_id ? new Set((products.find((p) => p.id === q.product_id)?.checkouts ?? []).map((c: any) => c.id)) : null;
  const orders = ((ordersRes.data ?? []) as any[]).filter((o) => !q.product_id || o.items.some((i: any) => i.kind === 'main' && i.product_id === q.product_id));
  // contagem feita no banco (antes baixava até 200 mil linhas de eventos para contar no servidor)
  const countEvents = async (type: string) => {
    if (checkoutIds && checkoutIds.size === 0) return 0;
    let q = supabase.from('events').select('id', { count: 'exact', head: true }).eq('type', type).gte('created_at', from.toISOString()).lt('created_at', to.toISOString());
    if (checkoutIds) q = q.in('checkout_id', [...checkoutIds] as string[]);
    const { count } = await q;
    return count ?? 0;
  };
  const [pageViews, initiatedCount] = await Promise.all([countEvents('page_view'), countEvents('initiate_checkout')]);

  const paid = orders.filter((o) => o.status === 'paid');
  const pending = orders.filter((o) => o.status === 'pending');
  const sum = (arr: any[]) => arr.reduce((s, o) => s + o.total_cents, 0);
  const bumpItems = paid.flatMap((o) => o.items.filter((i: any) => i.kind === 'bump'));
  const recovered = paid.filter((o) => o.recovery_sent_at && o.paid_at && new Date(o.paid_at) > new Date(o.recovery_sent_at));
  const initiated = initiatedCount;

  const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, paid: 0, revenue_cents: 0 }));
  const daily = new Map<string, { day: string; paid: number; revenue_cents: number }>();
  for (const o of paid) {
    const at = new Date(o.paid_at ?? o.created_at);
    const h = Number(hourFmt.format(at)) % 24;
    hourly[h].paid++;
    hourly[h].revenue_cents += o.total_cents;
    const d = dayFmt.format(at);
    const row = daily.get(d) ?? { day: d, paid: 0, revenue_cents: 0 };
    row.paid++;
    row.revenue_cents += o.total_cents;
    daily.set(d, row);
  }
  const methods = ['woovi', 'efi'].map((p) => {
    const list = paid.filter((o) => o.provider === p);
    return { method: p, label: p === 'efi' ? 'Pix · Efí' : 'Pix · Woovi', count: list.length, revenue_cents: sum(list) };
  });

  const top = new Map<string, { name: string; kind: string; number: number | null; count: number; revenue_cents: number }>();
  for (const it of paid.flatMap((o) => o.items)) {
    const k = `${it.kind}:${it.product_id ?? it.name}`;
    const t = top.get(k) ?? { name: it.name, kind: it.kind, number: it.product?.number ?? null, count: 0, revenue_cents: 0 };
    t.count++;
    t.revenue_cents += it.price_cents;
    top.set(k, t);
  }

  res.json({
    period: { from, to },
    products: products.map((p) => ({ id: p.id, name: p.name, number: p.number ?? null })),
    kpis: {
      paid_cents: sum(paid),
      paid_count: paid.length,
      pending_cents: sum(pending),
      pending_count: pending.length,
      orders_count: orders.length,
      initiated_count: initiated,
      page_views: pageViews,
      checkout_conversion: initiated ? paid.length / initiated : 0,
      pix_conversion: orders.length ? paid.length / orders.length : 0,
      bump_cents: bumpItems.reduce((s, i) => s + i.price_cents, 0),
      bump_count: bumpItems.length,
      recovered_cents: sum(recovered),
      recovered_count: recovered.length,
      avg_ticket_cents: paid.length ? Math.round(sum(paid) / paid.length) : 0,
    },
    hourly,
    daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
    methods,
    top_products: [...top.values()].sort((a, b) => b.revenue_cents - a.revenue_cents).slice(0, 8),
  });
});

/** Progresso da meta mensal (card da barra lateral). */
adminRouter.get('/progress', async (_req, res) => {
  const s = await getSettings();
  const now = new Date();
  const [y, m] = dayFmt.format(now).split('-').map(Number);
  const monthStart = new Date(Date.UTC(y, m - 1, 1, 3)); // 00:00 em São Paulo (UTC-3)
  const { data } = await supabase.from('orders').select('total_cents').eq('status', 'paid').gte('paid_at', monthStart.toISOString()).limit(100000);
  const month = (data ?? []).reduce((acc: number, o: any) => acc + o.total_cents, 0);
  res.json({ goal_cents: s.goal.monthlyCents, month_cents: month, updated_at: now.toISOString() });
});

// ------------------------------------------------------------------ integrações
adminRouter.get('/integrations', async (_req, res) => {
  const lastWebhooks = await supabase.from('webhook_logs').select('provider, status, error, reference, created_at').order('created_at', { ascending: false }).limit(20);
  const lastLogs = await supabase.from('integration_logs').select('integration, event, ok, http_status, message, created_at').order('created_at', { ascending: false }).limit(20);
  res.json({
    providers: providerStatus(),
    paytracking: { configured: (await allWebhooks()).some((w) => w.active), signed: (await allWebhooks()).some((w) => w.active && Boolean(w.secret)) },
    email: { configured: features.email, from: env.MAIL_FROM ?? null },
    webhooks: {
      woovi: `${env.PUBLIC_URL}/api/webhooks/woovi`,
      wooviSecretConfigured: Boolean(wooviConfig().webhookSecret),
      efi: `${env.PUBLIC_URL}/api/webhooks/efi`,
      efiSecretConfigured: Boolean(efiConfig().webhookSecret),
      efiSandbox: efiConfig().sandbox,
    },
    jobs: { enabled: env.JOBS_ENABLED },
    lastWebhooks: lastWebhooks.data ?? [],
    lastLogs: lastLogs.data ?? [],
  });
});

adminRouter.post('/integrations/paytracking/test', async (_req, res) => res.json(await testPayTracking()));

// ------------------------------------------------------------------ gateways (Efí / Woovi) configurados no painel
adminRouter.get('/gateways', async (_req, res) => {
  await refreshGateways(true);
  const w = wooviConfig();
  const e = efiConfig();
  const g = (await import('../services/gateways.js'));
  res.json({
    defaultProvider: g.globalProvider(),
    woovi: {
      configured: Boolean(w.appId),
      source: w.source,
      appId_hint: gwMask(w.appId),
      hasWebhookSecret: Boolean(w.webhookSecret),
      webhookUrl: `${env.PUBLIC_URL}/api/webhooks/woovi`,
    },
    efi: {
      configured: e.configured,
      clientId_hint: gwMask(e.clientId),
      hasClientSecret: Boolean(e.clientSecret),
      pixKey: e.pixKey, // chave Pix não é segredo (é o que o pagador vê)
      sandbox: e.sandbox,
      cert: e.pfx ? { source: e.certSource, name: g.efiCertMeta().name, uploadedAt: g.efiCertMeta().uploadedAt } : null,
      hasWebhookSecret: Boolean(e.webhookSecret),
      webhookUrl: `${env.PUBLIC_URL}/api/webhooks/efi`,
    },
  });
});

/** Gateway global: um só gateway para todos os produtos (também grava em todos os checkouts). */
adminRouter.put('/gateways/default', async (req, res) => {
  const b = z.object({ provider: z.enum(['woovi', 'efi']).nullable() }).parse(req.body);
  if (b.provider && !(b.provider === 'woovi' ? woovi : efi).isConfigured())
    throw new HttpError(400, `Configure a ${b.provider === 'woovi' ? 'Woovi' : 'Efí Bank'} antes de usá-la em todos os produtos`);
  await patchGateways((g) => ({ ...g, defaultProvider: b.provider }));
  let updated = 0;
  if (b.provider) {
    const { data, error } = await supabase.from('checkouts').update({ provider: b.provider }).neq('provider', b.provider).select('id');
    if (error) throw new HttpError(500, error.message);
    updated = data?.length ?? 0;
  }
  res.json({
    ok: true,
    message: b.provider
      ? `Todos os produtos agora recebem pelo ${b.provider === 'woovi' ? 'Woovi' : 'Efí Bank'}${updated ? ` (${updated} checkout${updated > 1 ? 's' : ''} atualizado${updated > 1 ? 's' : ''})` : ''}`
      : 'Cada checkout volta a usar o gateway escolhido nele',
  });
});

/** Mostra o segredo do webhook da Woovi (para colar no campo Authorization do painel Woovi). */
adminRouter.get('/gateways/woovi/webhook-secret', async (_req, res) => {
  let secret = wooviConfig().webhookSecret;
  if (!secret) {
    secret = randomSecret();
    await patchGateways((g) => ({ ...g, woovi: { ...g.woovi, webhookSecret: secret } }));
  }
  res.set('Cache-Control', 'no-store').json({ secret });
});

adminRouter.put('/gateways/woovi', async (req, res) => {
  const b = z.object({ appId: z.string().trim().max(500).optional(), regenerateSecret: z.boolean().optional() }).parse(req.body);
  await patchGateways((g) => ({
    ...g,
    woovi: {
      ...g.woovi,
      ...(b.appId ? { appId: b.appId } : {}),
      // o segredo só é criado/trocado a pedido (senão a Woovi passaria a ser recusada sem você colar o valor lá)
      ...(b.regenerateSecret ? { webhookSecret: randomSecret() } : {}),
    },
  }));
  res.json({ ok: true });
});

adminRouter.put('/gateways/efi', async (req, res) => {
  const b = z
    .object({
      clientId: z.string().trim().max(500).optional(),
      clientSecret: z.string().trim().max(500).optional(),
      pixKey: z.string().trim().max(120).optional(),
      sandbox: z.boolean().optional(),
    })
    .parse(req.body);
  await patchGateways((g) => ({
    ...g,
    efi: {
      ...g.efi,
      ...(b.clientId ? { clientId: b.clientId } : {}),
      ...(b.clientSecret ? { clientSecret: b.clientSecret } : {}),
      ...(b.pixKey !== undefined && b.pixKey !== '' ? { pixKey: b.pixKey } : {}),
      ...(b.sandbox !== undefined ? { sandbox: b.sandbox } : {}),
      // mantém o segredo em uso (inclusive o das variáveis), para não invalidar webhook já registrado
      webhookSecret: g.efi?.webhookSecret || env.EFI_WEBHOOK_SECRET || randomSecret(),
    },
  }));
  res.json({ ok: true });
});

/** Envio do certificado .p12 da Efí (base64 no JSON). Validado com a senha antes de salvar. */
adminRouter.post('/gateways/efi/certificate', async (req, res) => {
  const b = z
    .object({
      fileName: z.string().trim().max(200).regex(/\.(p12|pfx)$/i, 'Envie o arquivo .p12 baixado da Efí'),
      fileBase64: z.string().min(100).max(200_000),
      passphrase: z.string().max(200).optional().default(''),
    })
    .parse(req.body);
  const pfx = Buffer.from(b.fileBase64, 'base64');
  const problem = validatePfx(pfx, b.passphrase);
  if (problem) throw new HttpError(400, problem);
  await patchGateways((g) => ({
    ...g,
    efi: { ...g.efi, certBase64: pfx.toString('base64'), passphrase: b.passphrase, certName: b.fileName, certUploadedAt: new Date().toISOString() },
  }));
  res.json({ ok: true, message: 'Certificado salvo e validado' });
});

adminRouter.delete('/gateways/efi/certificate', async (_req, res) => {
  await patchGateways((g) => {
    const { certBase64: _c, passphrase: _p, certName: _n, certUploadedAt: _u, ...rest } = g.efi ?? {};
    return { ...g, efi: rest };
  });
  res.status(204).end();
});

adminRouter.post('/gateways/:name/test', async (req, res) => {
  const name = z.enum(['woovi', 'efi']).parse(req.params.name);
  const p = name === 'woovi' ? woovi : efi;
  if (!p.isConfigured()) return res.json({ ok: false, message: name === 'woovi' ? 'Informe o AppID primeiro' : 'Preencha Client ID, Client Secret, Chave Pix e envie o certificado' });
  try {
    await p.testConnection();
    res.json({ ok: true, message: name === 'woovi' ? 'Conexão com a Woovi OK' : `Conexão com a Efí OK (${efiConfig().sandbox ? 'homologação' : 'produção'})` });
  } catch (e: any) {
    res.json({ ok: false, message: String(e?.message ?? e) });
  }
});

// ------------------------------------------------------------------ WhatsApp (Evolution API)
adminRouter.get('/whatsapp', async (_req, res) => {
  const cfg = await getWhatsAppConfig();
  const { globalApiKey, ...rest } = cfg;
  res.json({ ...rest, globalApiKey: '', globalApiKey_hint: gwMask(globalApiKey), has_globalApiKey: Boolean(globalApiKey), instances: cfg.instances.map(({ token, ...i }) => ({ ...i, token_hint: gwMask(token), has_token: Boolean(token) })) });
});

/** Salva a configuração; instância com token vazio mantém o token já salvo (pelo nome). */
adminRouter.put('/whatsapp', async (req, res) => {
  const input = whatsappSchema.parse(req.body);
  const cur = await getWhatsAppConfig();
  const names = input.instances.map((i) => i.name);
  if (new Set(names).size !== names.length) throw new HttpError(400, 'Há instâncias com o mesmo nome');
  const instances = input.instances.map((i) => ({ ...i, token: i.token || cur.instances.find((c) => c.name === i.name)?.token || '' }));
  const globalApiKey = input.globalApiKey || cur.globalApiKey;
  if (input.enabled && (!input.apiUrl || !instances.some((i) => i.active && (i.token || globalApiKey)))) throw new HttpError(400, 'Informe a URL da API e pelo menos uma instância ativa com token (ou a API Key global)');
  await saveWhatsAppConfig({ ...input, globalApiKey, instances });
  res.json({ ok: true });
});

adminRouter.get('/whatsapp/status', async (_req, res) => res.json(await instancesStatus()));

/** Busca as instâncias na Evolution (nome exato, status, número). Tokens não vão para o navegador. */
adminRouter.post('/whatsapp/discover', async (req, res) => {
  const b = z.object({ apiUrl: z.string().trim().optional(), apiKey: z.string().trim().optional() }).parse(req.body);
  const cur = await getWhatsAppConfig();
  const apiUrl = b.apiUrl ? whatsappSchema.shape.apiUrl.parse(b.apiUrl) : cur.apiUrl;
  const key = b.apiKey || cur.globalApiKey || cur.instances.find((i) => i.token)?.token || '';
  const r = await fetchEvolutionInstances(apiUrl, key);
  if (!r.ok) return res.json(r);
  res.json({ ok: true, items: r.items.map(({ token, ...i }) => ({ ...i, hasToken: Boolean(token) })) });
});

/** Importa instâncias escolhidas: salva nome exato e token vindo da Evolution (ou usa a API Key global). */
adminRouter.post('/whatsapp/import', async (req, res) => {
  const b = z.object({ apiUrl: z.string().trim().optional(), apiKey: z.string().trim().optional(), names: z.array(z.string().min(1)).min(1).max(20), replace: z.boolean().default(true) }).parse(req.body);
  const cur = await getWhatsAppConfig();
  const apiUrl = b.apiUrl ? whatsappSchema.shape.apiUrl.parse(b.apiUrl) : cur.apiUrl;
  const key = b.apiKey || cur.globalApiKey || cur.instances.find((i) => i.token)?.token || '';
  const r = await fetchEvolutionInstances(apiUrl, key);
  if (!r.ok) throw new HttpError(400, r.error);
  const chosen = r.items.filter((i) => b.names.includes(i.name));
  if (!chosen.length) throw new HttpError(400, 'Nenhuma das instâncias escolhidas foi encontrada na Evolution');
  const imported = chosen.map((i) => ({ name: i.name, token: i.token ?? '', active: true }));
  const keep = b.replace ? [] : cur.instances.filter((c) => !imported.some((i) => i.name === c.name));
  const globalApiKey = b.apiKey || cur.globalApiKey || (imported.some((i) => !i.token) ? key : '');
  await saveWhatsAppConfig({ ...cur, apiUrl, globalApiKey, instances: [...keep, ...imported] });
  res.json({ ok: true, count: imported.length });
});
/** Cria uma instância nova na Evolution pelo painel e já a deixa no rodízio do checkout. */
adminRouter.post('/whatsapp/instances', async (req, res) => {
  const b = z
    .object({
      name: z.string().trim().regex(/^[A-Za-z0-9_-]{2,40}$/, 'Use de 2 a 40 letras, números, - ou _ (sem espaços)'),
      number: z.string().trim().max(30).optional().nullable(),
    })
    .parse(req.body);
  const cfg = await getWhatsAppConfig();
  if (cfg.instances.some((i) => i.name === b.name)) throw new HttpError(400, 'Já existe uma instância com esse nome no checkout');
  const r = await evolutionCreateInstance(cfg, b.name, b.number);
  if (!r.ok) return res.json(r);
  await saveWhatsAppConfig({ ...cfg, instances: [...cfg.instances, { name: b.name, token: r.token, active: true }] });
  res.json({ ok: true, name: b.name, qr: r.qr, pairingCode: r.pairingCode });
});
adminRouter.get('/whatsapp/instances/:name/connect', async (req, res) => {
  const name = z.string().regex(/^[A-Za-z0-9_-]{2,40}$/).parse(req.params.name);
  const number = typeof req.query.number === 'string' ? req.query.number : null;
  res.set('Cache-Control', 'no-store').json(await evolutionConnectStatus(await getWhatsAppConfig(), name, number));
});

adminRouter.get('/whatsapp/diagnose', async (_req, res) => res.json(await diagnoseWhatsApp({ jobsEnabled: env.JOBS_ENABLED, lastJobRunAt })));
adminRouter.get('/whatsapp/logs', async (_req, res) => {
  const { data } = await supabase.from('integration_logs').select('event, ok, message, created_at, order_id').eq('integration', 'whatsapp').order('created_at', { ascending: false }).limit(15);
  res.json(data ?? []);
});

adminRouter.post('/whatsapp/test', async (req, res) => {
  const { phone, kind } = z.object({ phone: z.string().min(8), kind: z.enum(['text', 'approved', 'recovery']).default('approved') }).parse(req.body);
  const p = normalizePhoneBR(phone);
  if (!p) throw new HttpError(400, 'Telefone inválido (use DDD + número)');
  const msg =
    kind === 'recovery'
      ? buildRecoveryMessage({ phone: p, name: 'Cliente Teste', link: `${env.PUBLIC_URL}/checkout?produto_id=exemplo`, attempt: 1, pixCode: '00020126...exemplo' })
      : kind === 'approved'
        ? buildApprovedMessage({ phone: p, name: 'Cliente Teste', totalCents: 9700, items: [{ name: 'Produto de exemplo', url: `${env.PUBLIC_URL}`, kind: 'main' }] })
        : 'Teste de envio do checkout: a integração com o WhatsApp está funcionando. 🙂';
  const r = await sendWhatsAppText(p, msg);
  await supabase.from('integration_logs').insert({ integration: 'whatsapp', event: `test_${kind}`, ok: r.ok, message: (r.ok ? `teste enviado (${r.instance})` : `${r.error ?? ''}${r.hint ? ` → ${r.hint}` : ''}`).slice(0, 500) });
  res.json({ ok: r.ok, message: r.ok ? `Mensagem de teste enviada pela instância ${r.instance}` : r.error, hint: r.hint });
});

adminRouter.get('/whatsapp/preview', async (_req, res) => {
  const phone = '5500000000000';
  res.json({
    approved: buildApprovedMessage({ phone, name: 'Maria Silva', totalCents: 11690, items: [{ name: 'Método Completo', url: 'https://link-de-acesso', kind: 'main' }, { name: 'Pack de Planilhas', url: 'https://link-do-bump', kind: 'bump' }] }),
    recovery1: buildRecoveryMessage({ phone, name: 'Maria Silva', link: `${env.PUBLIC_URL}/checkout?produto_id=…`, attempt: 1, pixCode: '00020126580014br.gov.bcb.pix…' }),
    recovery2: buildRecoveryMessage({ phone, name: 'Maria Silva', link: `${env.PUBLIC_URL}/checkout?produto_id=…`, attempt: 2, pixCode: null }),
  });
});

// ------------------------------------------------------------------ webhooks de saída (PayTracking e outros)
const webhookInput = z.object({
  name: z.string().trim().min(2, 'Dê um nome ao webhook').max(60),
  preset: z.enum(['paytracking', 'custom']).default('custom'),
  url: z
    .string()
    .trim()
    .url('URL inválida')
    .refine((u) => u.startsWith('https://') || !isProd, 'Use uma URL com https://'),
  token: z.string().trim().max(500).optional(),
  secret: z.string().trim().max(500).optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, 'Escolha pelo menos um evento'),
  active: z.boolean().default(true),
});

async function lastLogs() {
  const { data } = await supabase.from('integration_logs').select('integration, ok, http_status, message, created_at').like('integration', 'webhook:%').order('created_at', { ascending: false }).limit(200);
  const map = new Map<string, any>();
  for (const l of data ?? []) if (!map.has(l.integration)) map.set(l.integration, l);
  return map;
}

/** Lista com token/segredo mascarados — nunca devolve os valores. */
adminRouter.get('/webhooks', async (_req, res) => {
  const [items, last] = await Promise.all([allWebhooks(), lastLogs()]);
  res.json({
    url: `${env.PUBLIC_URL}`,
    events: WEBHOOK_EVENTS,
    items: items.map(({ token, secret, ...w }) => ({ ...w, token_hint: mask(token), has_secret: Boolean(secret), last: last.get(`webhook:${w.id}`) ?? null })),
  });
});

adminRouter.post('/webhooks', async (req, res) => {
  const input = webhookInput.parse(req.body);
  const items = await listWebhooks();
  if (items.length >= 20) throw new HttpError(400, 'Limite de 20 webhooks');
  const w: Webhook = { id: newWebhookId(), name: input.name, preset: input.preset, url: input.url, token: input.token ?? '', secret: input.secret ?? '', events: input.events, active: input.active, created_at: new Date().toISOString() };
  await saveWebhooks([...items, w]);
  res.status(201).json({ id: w.id });
});

/** Atualiza; token/segredo vazios ou ausentes mantêm o valor salvo (use clear_secret para remover). */
adminRouter.put('/webhooks/:id', async (req, res) => {
  const id = String(req.params.id);
  if (id === 'env') throw new HttpError(400, 'Este webhook vem das variáveis de ambiente. Crie um no painel para editar por aqui.');
  const input = webhookInput.extend({ clear_secret: z.boolean().optional() }).parse(req.body);
  const items = await listWebhooks();
  const cur = items.find((w) => w.id === id);
  if (!cur) throw new HttpError(404, 'Webhook não encontrado');
  const next: Webhook = {
    ...cur,
    name: input.name,
    preset: input.preset,
    url: input.url,
    events: input.events,
    active: input.active,
    token: input.token ? input.token : cur.token,
    secret: input.clear_secret ? '' : input.secret ? input.secret : cur.secret,
  };
  await saveWebhooks(items.map((w) => (w.id === id ? next : w)));
  res.json({ ok: true });
});

adminRouter.delete('/webhooks/:id', async (req, res) => {
  const id = String(req.params.id);
  if (id === 'env') throw new HttpError(400, 'Remova as variáveis PAYTRACKING_* na Hostinger para desativar este webhook.');
  const items = await listWebhooks();
  await saveWebhooks(items.filter((w) => w.id !== id));
  res.status(204).end();
});

adminRouter.post('/webhooks/:id/test', async (req, res) => {
  const w = (await allWebhooks()).find((x) => x.id === String(req.params.id));
  if (!w) throw new HttpError(404, 'Webhook não encontrado');
  const r = await testWebhook(w);
  await supabase.from('integration_logs').insert({ integration: `webhook:${w.id}`, event: 'connection_test', ok: r.ok, http_status: r.status, message: `${w.name}: ${r.message}`.slice(0, 500) });
  res.json(r);
});
adminRouter.post('/integrations/email/test', async (req, res) => {
  const to = z.object({ to: z.string().email() }).parse(req.body).to;
  res.json(await testEmail(to));
});
adminRouter.post('/integrations/efi/register-webhook', async (_req, res) => {
  if (!efi.isConfigured()) throw new HttpError(400, 'Configure a Efí primeiro (Client ID, Client Secret, Chave Pix e certificado)');
  let secret = efiConfig().webhookSecret;
  if (!secret) {
    secret = randomSecret();
    await patchGateways((g) => ({ ...g, efi: { ...g.efi, webhookSecret: secret } }));
  }
  const url = `${env.PUBLIC_URL}/api/webhooks/efi?hmac=${encodeURIComponent(secret)}&ignorar=`;
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
