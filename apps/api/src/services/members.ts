import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { HttpError, productCode, supabase } from '../lib/core.js';

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
    supabase.from('products').select('id, number, name, description, image_url, members_banner_url, active').eq('members_enabled', true),
  ]);
  const all = ((products ?? []) as any[]).filter((p) => owned.has(p.id) || p.active);
  if (!all.length) return { customer, courses: [], extras: [] };
  const ids = all.map((p) => p.id);
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
  // cursos que a pessoa ainda não tem: aparecem bloqueados, com o link do checkout para liberar
  const extras = all
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
      };
    });
  return { customer, courses, extras };
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
