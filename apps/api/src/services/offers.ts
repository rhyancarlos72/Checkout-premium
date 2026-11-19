import { z } from 'zod';
import { HttpError, supabase } from '../lib/core.js';
import { createOrder } from './orders.js';
import { isLinkToken, upsell2Coupon, upsell2Discount } from './waAudio.js';

/**
 * Páginas de vendas de upsell: título + vídeo (VSL) + botão; o pagamento acontece na própria página
 * (Pix do checkout escolhido, ex.: o do Clube com Pix Automático). Endereço: /oferta/{slug}.
 * Visitas/cliques: tabela events (offer_view / offer_click, data.offer = slug). Vendas: orders.tracking.offer.
 */
const httpsUrl = z
  .string()
  .trim()
  .max(600)
  .refine((u) => u === '' || /^https:\/\/\S+$/.test(u), 'Use um endereço https')
  .transform((u) => u || null)
  .nullable()
  .optional();

export const offerSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{3,60}$/, 'Endereço: só letras minúsculas, números e hífen (3 a 60)'),
  checkout_id: z.string().uuid('Escolha o checkout que vai cobrar'),
  title: z.string().trim().min(2, 'Dê um nome à página').max(120),
  headline: z.string().trim().min(2, 'Escreva o título da página').max(200),
  subheadline: z.string().trim().max(400).nullable().optional().transform((v) => v || null),
  video_url: httpsUrl,
  video_sd_url: httpsUrl,
  poster_url: httpsUrl,
  cta_text: z.string().trim().min(2).max(60).default('Quero entrar agora'),
  bullets: z.array(z.string().trim().min(1).max(120)).max(4).default([]),
  guarantee: z.string().trim().max(200).nullable().optional().transform((v) => v || null),
  button_delay_seconds: z.number().int().min(0).max(3600).default(0),
  active: z.boolean().default(true),
  // visual VSL
  banner_text: z.string().trim().max(80).nullable().optional().transform((v) => v || null),
  pre_headline: z.string().trim().max(120).nullable().optional().transform((v) => v || null),
  decline_text: z.string().trim().min(2).max(80).default('Não quero, obrigado'),
  video_ratio: z.enum(['16:9', '9:16', '1:1', '4:5']).default('16:9'),
  accent_color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Cor inválida').default('#f97316'),
});
/** campos da migração 20261121 (visual VSL): sem o SQL, a página segue com o visual básico */
export const OFFER_NEW_FIELDS = ['banner_text', 'pre_headline', 'decline_text', 'video_ratio', 'accent_color'] as const;
export const missingOfferColumns = (e: { message?: string } | null) => !!e && /banner_text|pre_headline|decline_text|video_ratio|accent_color|page_id|schema cache|column/i.test(e.message ?? '');
export type OfferInput = z.infer<typeof offerSchema>;

export const OFFER_SELECT_BASE = 'id, slug, checkout_id, title, headline, subheadline, video_url, video_sd_url, poster_url, cta_text, bullets, guarantee, button_delay_seconds, active, created_at, updated_at, checkout:checkouts(slug, name)';
export const OFFER_SELECT = `${OFFER_SELECT_BASE.replace(', checkout:', ', banner_text, pre_headline, decline_text, video_ratio, accent_color, checkout:')}`;
/** Consulta com os campos novos; se o SQL novo ainda não rodou, consulta sem eles. */
export async function selectOffers<T>(run: (select: string) => PromiseLike<{ data: T; error: any }>) {
  const r = await run(OFFER_SELECT);
  return r.error && missingOfferColumns(r.error) ? run(OFFER_SELECT_BASE) : r;
}

/** Página ativa pelo endereço (com o checkout que cobra). */
export async function loadOffer(slug: string) {
  if (!/^[a-z0-9-]{3,60}$/.test(slug)) throw new HttpError(404, 'Página não encontrada');
  const { data, error } = await selectOffers((sel) => supabase.from('upsell_pages').select(sel).eq('slug', slug).maybeSingle());
  if (error || !data || !(data as any).active || !(data as any).checkout?.slug) throw new HttpError(404, 'Página não encontrada');
  return data as any;
}

/** Dados públicos da página (sem nada interno). */
export function publicOffer(p: any) {
  return {
    slug: p.slug,
    headline: p.headline,
    subheadline: p.subheadline ?? null,
    video: p.video_url ? { hd: p.video_url, sd: p.video_sd_url ?? null, poster: p.poster_url ?? null } : null,
    poster: p.poster_url ?? null,
    cta_text: p.cta_text,
    bullets: Array.isArray(p.bullets) ? p.bullets.slice(0, 4) : [],
    guarantee: p.guarantee ?? null,
    button_delay_seconds: p.button_delay_seconds ?? 0,
    checkout_slug: p.checkout.slug,
    banner_text: p.banner_text ?? null,
    pre_headline: p.pre_headline ?? null,
    decline_text: p.decline_text || 'Não quero, obrigado',
    video_ratio: p.video_ratio || '16:9',
    accent_color: p.accent_color || '#f97316',
  };
}

/**
 * Dados da pessoa para já vir preenchido: veio do link do áudio (?wa=TOKEN) ou de um pedido pago (?o=token do pedido).
 * Só nome, e-mail e WhatsApp (o CPF a pessoa confirma na hora).
 */
async function offerCustomerId(q: { wa?: unknown; o?: unknown }) {
  let customerId: string | null = null;
  if (isLinkToken(q.wa)) {
    const { data } = await supabase.from('wa_links').select('customer_id').eq('token', q.wa).maybeSingle();
    customerId = (data as any)?.customer_id ?? null;
  }
  if (!customerId && typeof q.o === 'string' && /^[a-f0-9]{48}$/.test(q.o)) {
    const { data } = await supabase.from('orders').select('customer_id').eq('public_token', q.o).maybeSingle();
    customerId = (data as any)?.customer_id ?? null;
  }
  return customerId;
}
async function offerCustomer(q: { wa?: unknown; o?: unknown }) {
  const id = await offerCustomerId(q);
  if (!id) return null;
  const { data } = await supabase.from('customers').select('name, email, phone, document').eq('id', id).maybeSingle();
  return (data as { name: string; email: string; phone: string | null; document: string | null } | null) ?? null;
}
/** Última chamada (?wa= de um link de upsell 2 ainda válido): o 1º mês sai pelo preço da campanha. */
export async function offerDiscount(q: { wa?: unknown }) {
  return upsell2Discount(q.wa).catch(() => null);
}

export async function offerPrefill(q: { wa?: unknown; o?: unknown }) {
  const c = await offerCustomer(q);
  // o CPF nunca sai do servidor: só avisa se já está no cadastro (compra a um toque sem pedir de novo)
  return c ? { name: c.name ?? '', email: c.email ?? '', phone: c.phone ?? '', has_document: Boolean(c.document && c.document.length >= 11) } : null;
}

/**
 * Compra a um toque na página de vendas: quem veio de um pedido pago (?o=) ou do link do áudio (?wa=)
 * compra com os dados do cadastro (o CPF, se já houver, é usado aqui no servidor). Sem cadastro: 400 (usa o formulário).
 */
export async function buyOffer(
  slug: string,
  body: { o?: unknown; wa?: unknown; document?: unknown; tracking?: unknown; customer?: { name: string; email: string; phone?: string | null } | null },
  meta: { ip: string | null; userAgent: string | null; geo?: Record<string, string> },
) {
  const p = await loadOffer(slug);
  // dados digitados no formulário (ou "alterar") têm prioridade; senão, o cadastro de quem veio do pedido/áudio
  const known = await offerCustomer(body);
  const c = body.customer?.email ? { ...body.customer, phone: body.customer.phone ?? null, document: known && known.email === body.customer.email ? known.document : null } : known;
  if (!c?.email || !c.name) throw new HttpError(400, 'Preencha seus dados para continuar');
  const doc = typeof body.document === 'string' && body.document.replace(/\D/g, '').length >= 11 ? body.document : c.document;
  // última chamada: o desconto do 1º mês vale só pelo link válido (o cupom nunca aparece na página)
  const coupon = (await offerDiscount(body)) ? await upsell2Coupon(p.checkout.slug).catch(() => null) : null;
  const tracking = body.tracking && typeof body.tracking === 'object' ? (body.tracking as Record<string, unknown>) : {};
  return createOrder(
    {
      checkout_slug: p.checkout.slug,
      customer: { name: c.name, email: c.email, phone: c.phone, document: doc ?? null },
      bump_ids: [],
      coupon_code: coupon,
      tracking: { ...tracking, offer: p.slug },
      payment_method: 'pix',
      card: null,
    },
    meta,
  );
}

/** Números de cada página: visitas, cliques no botão, Pix gerados, vendas pagas e faturamento. */
export async function offerStats(pages: { slug: string; checkout_id: string }[]) {
  const out = new Map<string, { views: number; clicks: number; orders: number; paid: number; revenue_cents: number }>();
  for (const p of pages) out.set(p.slug, { views: 0, clicks: 0, orders: 0, paid: 0, revenue_cents: 0 });
  if (!pages.length) return out;
  const ids = [...new Set(pages.map((p) => p.checkout_id))];
  const [ev, ords] = await Promise.all([
    supabase.from('events').select('type, data, session_id').in('checkout_id', ids).in('type', ['offer_view', 'offer_click']).limit(50000),
    supabase.from('orders').select('status, total_cents, tracking').in('checkout_id', ids).not('tracking->>offer', 'is', null).limit(20000),
  ]);
  const seen = new Set<string>(); // visitas únicas por sessão
  for (const e of (ev.data ?? []) as any[]) {
    const s = out.get(String(e.data?.offer ?? ''));
    if (!s) continue;
    const key = `${e.type}|${e.data?.offer}|${e.session_id ?? Math.random()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (e.type === 'offer_view') s.views++;
    else s.clicks++;
  }
  for (const o of (ords.data ?? []) as any[]) {
    const s = out.get(String(o.tracking?.offer ?? ''));
    if (!s) continue;
    s.orders++;
    if (o.status === 'paid') {
      s.paid++;
      s.revenue_cents += o.total_cents ?? 0;
    }
  }
  return out;
}
