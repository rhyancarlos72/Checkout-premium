import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { z } from 'zod';
import { HttpError, productCode, supabase } from '../lib/core.js';
import { orgKey, runAsOrg } from '../lib/tenant.js';

// ------------------------------------------------------------------ sessão do aluno
// Token assinado (HMAC) com o id do cliente e a validade: não precisa de tabela de sessões.
const SESSION_DAYS = 30;
const key = () => crypto.createHmac('sha256', env.SUPABASE_SERVICE_ROLE_KEY).update('members-session-v1').digest();
const sign = (payload: string) => crypto.createHmac('sha256', key()).update(payload).digest('base64url');

export function createMemberSession(customerId: string) {
  const payload = Buffer.from(JSON.stringify({ c: customerId, e: Date.now() + SESSION_DAYS * 86400_000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
export function readMemberSession(token: string | undefined | null): string | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const { c, e } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof c === 'string' && typeof e === 'number' && e > Date.now() ? c : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ código por e-mail
export const hashCode = (email: string, code: string) => crypto.createHmac('sha256', key()).update(`${email.toLowerCase()}:${code}`).digest('hex');
export const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

// ------------------------------------------------------------------ acesso
/** Produtos que o cliente comprou (pedidos pagos; order bumps contam). */
export async function ownedProductIds(customerId: string) {
  const { data } = await supabase.from('orders').select('id, items:order_items(product_id)').eq('customer_id', customerId).eq('status', 'paid');
  const ids = new Set<string>();
  for (const o of (data ?? []) as any[]) for (const i of o.items ?? []) if (i.product_id) ids.add(i.product_id);
  return ids;
}

/** Link que entra direto na área de membros a partir do pedido (entrega, página do Pix, WhatsApp). */
export const membersLink = (publicToken: string) => `${env.PUBLIC_URL}/membros/entrar?o=${publicToken}`;

type ModuleRow = { id: string; product_id: string; section_id: string; title: string; subtitle: string | null; cover_url: string | null; sort: number };

/** Monta a área do aluno: cursos liberados (seções → módulos) e cursos adicionais bloqueados. */
export async function memberHome(customerId: string) {
  const owned = await ownedProductIds(customerId);
  const [{ data: customer }, { data: products }] = await Promise.all([
    supabase.from('customers').select('name, email').eq('id', customerId).maybeSingle(),
    supabase.from('products').select('*').eq('members_enabled', true), // '*' inclui org_id quando o marketplace está ativo
  ]);
  const all = ((products ?? []) as any[]).filter((p) => owned.has(p.id) || p.active);
  const ids = all.length ? all.map((p) => p.id) : ['00000000-0000-0000-0000-000000000000'];
  const [{ data: sections }, { data: modules }, { data: lessons }, { data: progress }, { data: checkouts }] = await Promise.all([
    supabase.from('member_sections').select('id, product_id, title, sort').in('product_id', ids).order('sort', { ascending: true }),
    supabase.from('member_modules').select('id, product_id, section_id, title, subtitle, cover_url, sort').in('product_id', ids).order('sort', { ascending: true }),
    supabase.from('member_lessons').select('id, module_id, product_id').in('product_id', ids),
    supabase.from('member_progress').select('lesson_id').eq('customer_id', customerId),
    supabase.from('checkouts').select('slug, product_id, active, created_at').in('product_id', ids).eq('active', true).order('created_at', { ascending: true }),
  ]);
  const done = new Set(((progress ?? []) as any[]).map((p) => p.lesson_id));
  const lessonsByModule = new Map<string, string[]>();
  for (const l of (lessons ?? []) as any[]) lessonsByModule.set(l.module_id, [...(lessonsByModule.get(l.module_id) ?? []), l.id]);
  const checkoutOf = new Map<string, string>();
  for (const c of (checkouts ?? []) as any[]) if (!checkoutOf.has(c.product_id)) checkoutOf.set(c.product_id, c.slug);

  const moduleView = (m: ModuleRow) => {
    const ls = lessonsByModule.get(m.id) ?? [];
    return { id: m.id, title: m.title, subtitle: m.subtitle, cover_url: m.cover_url, lessons: ls.length, completed: ls.filter((id) => done.has(id)).length };
  };
  const sort = (a: { sort: number }, b: { sort: number }) => a.sort - b.sort;
  const courses = all
    .filter((p) => owned.has(p.id))
    .map((p) => {
      const secs = ((sections ?? []) as any[]).filter((s) => s.product_id === p.id).sort(sort);
      const mods = ((modules ?? []) as ModuleRow[]).filter((m) => m.product_id === p.id);
      const total = mods.reduce((n, m) => n + (lessonsByModule.get(m.id)?.length ?? 0), 0);
      const completed = mods.reduce((n, m) => n + (lessonsByModule.get(m.id) ?? []).filter((id) => done.has(id)).length, 0);
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        image_url: p.image_url,
        banner_url: p.members_banner_url ?? null,
        progress: { total, completed },
        sections: secs.map((s) => ({ id: s.id, title: s.title, modules: mods.filter((m) => m.section_id === s.id).sort(sort).map(moduleView) })).filter((s) => s.modules.length),
      };
    });
  // vitrine escolhida no painel (Área de membros → Produtos adicionais); sem escolha: automática
  // cursos que a pessoa ainda não tem: aparecem bloqueados, com o link do checkout para liberar
  const autoExtras = all
    .filter((p) => !owned.has(p.id) && p.active && checkoutOf.has(p.id))
    .map((p) => {
      const firstModule = ((modules ?? []) as ModuleRow[]).filter((m) => m.product_id === p.id).sort(sort)[0];
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        cover_url: firstModule?.cover_url ?? p.image_url,
        modules: ((modules ?? []) as ModuleRow[]).filter((m) => m.product_id === p.id).length,
        checkout_url: `/checkout?produto_id=${checkoutOf.get(p.id)}`,
        code: productCode(p.number),
        badge: null as string | null,
        price_cents: null as number | null,
        org_id: (p.org_id ?? null) as string | null,
      };
    });
  // vitrine por produtor: o aluno só vê ofertas dos produtores de quem ele comprou (nunca de outros)
  const myOrgs = [...new Set(all.filter((p) => owned.has(p.id)).map((p) => (p.org_id ?? null) as string | null))];
  let offers = { title: 'Cursos adicionais', subtitle: 'Libere mais conteúdos' };
  const extras: Omit<(typeof autoExtras)[number], 'org_id'>[] = [];
  for (const org of myOrgs) {
    const cfg = await runAsOrg(org, () => getMembersConfig());
    if (!extras.length) offers = { title: cfg.offersTitle, subtitle: cfg.offersSubtitle };
    if (cfg.offers.length) extras.push(...(await manualExtras(owned, cfg)));
    else extras.push(...autoExtras.filter((x) => x.org_id === org).map(({ org_id: _o, ...x }) => x));
  }
  return { customer, courses, extras, offers };
}

// ------------------------------------------------------------------ vitrine de produtos adicionais
const offerSchema = z.object({
  product_id: z.string().uuid(),
  title: z.string().trim().max(80).nullable().optional().transform((v) => v || null),
  description: z.string().trim().max(300).nullable().optional().transform((v) => v || null),
  cover_url: z.string().trim().url().max(1000).or(z.literal('')).nullable().optional().transform((v) => v || null),
  badge: z.string().trim().max(20).nullable().optional().transform((v) => v || null),
});
export const membersConfigSchema = z.object({
  offersTitle: z.string().trim().min(1).max(60).default('Cursos adicionais'),
  offersSubtitle: z.string().trim().max(120).default('Libere mais conteúdos'),
  offers: z.array(offerSchema).max(30).default([]),
});
export type MembersConfig = z.infer<typeof membersConfigSchema>;
export async function getMembersConfig(): Promise<MembersConfig> {
  const { data } = await supabase.from('settings').select('value').eq('key', await orgKey('members')).maybeSingle();
  const r = membersConfigSchema.safeParse((data as any)?.value ?? {});
  return r.success ? r.data : membersConfigSchema.parse({});
}
export async function saveMembersConfig(input: unknown) {
  const value = membersConfigSchema.parse(input);
  const { error } = await supabase.from('settings').upsert({ key: await orgKey('members'), value, updated_at: new Date().toISOString() });
  if (error) throw new HttpError(500, error.message);
  return value;
}

/** Produtos escolhidos no painel, na ordem definida, menos os que a pessoa já tem. */
async function manualExtras(owned: Set<string>, cfg: MembersConfig) {
  const ids = cfg.offers.map((o) => o.product_id).filter((id) => !owned.has(id));
  if (!ids.length) return [];
  const [{ data: products }, { data: checkouts }, { data: modules }] = await Promise.all([
    supabase.from('products').select('*').in('id', ids),
    supabase.from('checkouts').select('slug, product_id, price_cents, active, created_at').in('product_id', ids).eq('active', true).order('created_at', { ascending: true }),
    supabase.from('member_modules').select('product_id, cover_url, sort').in('product_id', ids).order('sort', { ascending: true }),
  ]);
  const prod = new Map(((products ?? []) as any[]).map((p) => [p.id, p]));
  const ck = new Map<string, any>();
  for (const c of (checkouts ?? []) as any[]) if (!ck.has(c.product_id)) ck.set(c.product_id, c);
  const firstCover = new Map<string, string>();
  for (const m of (modules ?? []) as any[]) if (m.cover_url && !firstCover.has(m.product_id)) firstCover.set(m.product_id, m.cover_url);
  return cfg.offers
    .filter((o) => !owned.has(o.product_id) && prod.get(o.product_id)?.active && ck.has(o.product_id))
    .map((o) => {
      const p = prod.get(o.product_id);
      const c = ck.get(o.product_id);
      return {
        id: p.id,
        name: o.title || p.name,
        description: o.description || p.description,
        cover_url: o.cover_url || firstCover.get(p.id) || p.image_url,
        modules: 0,
        checkout_url: `/checkout?produto_id=${c.slug}`,
        code: productCode(p.number),
        badge: o.badge,
        price_cents: (c.price_cents ?? p.price_cents) as number | null,
      };
    });
}

/** Módulo com as aulas (só para quem tem o produto). */
export async function memberModule(customerId: string, moduleId: string) {
  const { data: m } = await supabase.from('member_modules').select('id, product_id, section_id, title, subtitle, cover_url, sort').eq('id', moduleId).maybeSingle();
  const mod = m as ModuleRow | null;
  if (!mod) throw new HttpError(404, 'Módulo não encontrado');
  const owned = await ownedProductIds(customerId);
  if (!owned.has(mod.product_id)) throw new HttpError(403, 'Você ainda não tem acesso a este conteúdo');
  const [{ data: lessons }, { data: progress }, { data: product }, { data: siblings }] = await Promise.all([
    supabase.from('member_lessons').select('id, title, description, video_url, duration, attachments, sort').eq('module_id', moduleId).order('sort', { ascending: true }),
    supabase.from('member_progress').select('lesson_id').eq('customer_id', customerId),
    supabase.from('products').select('name').eq('id', mod.product_id).maybeSingle(),
    supabase.from('member_modules').select('id, title, sort, section_id').eq('product_id', mod.product_id).order('sort', { ascending: true }),
  ]);
  const done = new Set(((progress ?? []) as any[]).map((p) => p.lesson_id));
  // próximo módulo (mesma ordem da tela inicial: seção, depois módulo)
  const { data: secs } = await supabase.from('member_sections').select('id, sort').eq('product_id', mod.product_id);
  const secSort = new Map(((secs ?? []) as any[]).map((s) => [s.id, s.sort]));
  const ordered = ((siblings ?? []) as any[]).sort((a, b) => (secSort.get(a.section_id) ?? 0) - (secSort.get(b.section_id) ?? 0) || a.sort - b.sort);
  const idx = ordered.findIndex((x) => x.id === mod.id);
  const next = idx >= 0 ? ordered[idx + 1] : null;
  return {
    id: mod.id,
    title: mod.title,
    subtitle: mod.subtitle,
    cover_url: mod.cover_url,
    course: (product as any)?.name ?? '',
    next_module: next ? { id: next.id, title: next.title } : null,
    lessons: ((lessons ?? []) as any[]).map((l) => ({ ...l, attachments: Array.isArray(l.attachments) ? l.attachments : [], completed: done.has(l.id) })),
  };
}

export async function setLessonDone(customerId: string, lessonId: string, done: boolean) {
  const { data: l } = await supabase.from('member_lessons').select('id, product_id').eq('id', lessonId).maybeSingle();
  if (!l) throw new HttpError(404, 'Aula não encontrada');
  const owned = await ownedProductIds(customerId);
  if (!owned.has((l as any).product_id)) throw new HttpError(403, 'Sem acesso');
  if (done) await supabase.from('member_progress').upsert({ customer_id: customerId, lesson_id: lessonId, completed_at: new Date().toISOString() }, { onConflict: 'customer_id,lesson_id' });
  else await supabase.from('member_progress').delete().eq('customer_id', customerId).eq('lesson_id', lessonId);
}

// ------------------------------------------------------------------ conta do aluno (e-mail + senha)
const PASS_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O, 1/l/I
/** Senha aleatória fácil de digitar no celular (ex.: "Kp7m-x3Qa"). */
export function randomPassword() {
  const pick = (n: number) => Array.from({ length: n }, () => PASS_ALPHABET[crypto.randomInt(PASS_ALPHABET.length)]).join('');
  return `${pick(4)}-${pick(4)}`;
}
export function hashPassword(password: string) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}
export function verifyPassword(password: string, stored: string) {
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const a = crypto.scryptSync(password, Buffer.from(salt, 'base64url'), 32);
  const b = Buffer.from(hash, 'base64url');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const encKey = () => crypto.createHmac('sha256', env.SUPABASE_SERVICE_ROLE_KEY).update('members-password-enc-v1').digest();
function encrypt(text: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
}
function decrypt(payload: string | null | undefined) {
  try {
    const [iv, tag, body] = String(payload ?? '').split('.');
    const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export interface MemberAccess {
  loginUrl: string;
  email: string;
  /** senha gerada pelo sistema; null quando o aluno já trocou a senha (não temos como reenviar) */
  password: string | null;
}

/**
 * Pedido com produto entregue pela área de membros → garante a conta do aluno (e-mail + senha aleatória)
 * e devolve os dados de acesso para o e-mail e o WhatsApp de entrega. Idempotente: compras seguintes
 * reaproveitam a mesma conta e a mesma senha (enquanto o aluno não trocar).
 */
export async function ensureMemberAccess(orderId: string): Promise<MemberAccess | null> {
  const { data } = await supabase
    .from('orders')
    .select('customer_id, customer:customers(email), items:order_items(product:products(members_enabled))')
    .eq('id', orderId)
    .maybeSingle();
  const o: any = data;
  if (!o?.customer_id || !o.customer?.email) return null;
  if (!(o.items ?? []).some((i: any) => i.product?.members_enabled)) return null;
  const read = async () => (await supabase.from('member_accounts').select('password_hash, password_enc').eq('customer_id', o.customer_id).maybeSingle()).data as any;
  let acc = await read();
  if (!acc) {
    const password = randomPassword();
    // e-mail e WhatsApp rodam ao mesmo tempo: quem chegar primeiro cria, o outro reaproveita
    await supabase.from('member_accounts').upsert({ customer_id: o.customer_id, password_hash: hashPassword(password), password_enc: encrypt(password) }, { onConflict: 'customer_id', ignoreDuplicates: true });
    acc = await read();
  }
  return { loginUrl: `${env.PUBLIC_URL}/membros/login`, email: o.customer.email, password: decrypt(acc?.password_enc) };
}

/** Login do aluno: e-mail + senha → id do cliente (ou null). */
export async function loginWithPassword(email: string, password: string) {
  const { data: c } = await supabase.from('customers').select('id').eq('email', email).maybeSingle();
  if (!c) {
    hashPassword(password); // mesmo tempo de resposta com ou sem conta
    return null;
  }
  const { data: acc } = await supabase.from('member_accounts').select('password_hash').eq('customer_id', (c as any).id).maybeSingle();
  if (!acc || !verifyPassword(password, (acc as any).password_hash)) return null;
  await supabase.from('member_accounts').update({ last_login_at: new Date().toISOString() }).eq('customer_id', (c as any).id);
  return (c as any).id as string;
}

/** Aluno define a própria senha (depois disso a senha gerada deixa de existir). */
export async function setMemberPassword(customerId: string, password: string) {
  await supabase
    .from('member_accounts')
    .upsert({ customer_id: customerId, password_hash: hashPassword(password), password_enc: null, updated_at: new Date().toISOString() }, { onConflict: 'customer_id' });
}
