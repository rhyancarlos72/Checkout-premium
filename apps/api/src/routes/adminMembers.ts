import { Router } from 'express';
import { z } from 'zod';
import { HttpError, must, productCode } from '../lib/core.js';
// filtro por organização (o roteador é montado dentro do /admin, que já define o produtor logado)
import { currentOrgId, isOwnerOrg, tenantDb as supabase } from '../lib/tenant.js';
import { importDrivePdf } from '../services/memberFiles.js';
import { getMembersConfig, memberTabs, saveMembersConfig } from '../services/members.js';
import crypto from 'node:crypto';

/** Painel → Área de membros: seções, módulos e aulas de cada produto. (montado em /api/admin/members) */
export const adminMembersRouter = Router();
const uuid = z.string().uuid();
/** caminho de PDF guardado pelo painel: [org/]members/AAAA-MM/uuid.pdf */
const PDF_PATH = /^(?:[0-9a-f-]{36}\/)?members\/\d{4}-\d{2}\/[0-9a-f-]{36}\.pdf$/;
const urlOrNull = z.string().trim().url().max(1000).or(z.literal('')).nullable().optional().transform((v) => v || null);

adminMembersRouter.get('/products', async (_req, res) => {
  const [{ data: products }, { data: modules }, { data: lessons }] = await Promise.all([
    supabase.from('products').select('id, number, name, image_url, active, members_enabled').order('created_at', { ascending: false }),
    supabase.from('member_modules').select('product_id'),
    supabase.from('member_lessons').select('product_id'),
  ]);
  const count = (rows: any[] | null, id: string) => (rows ?? []).filter((r) => r.product_id === id).length;
  res.json(((products ?? []) as any[]).map((p) => ({ ...p, code: productCode(p.number), modules: count(modules, p.id), lessons: count(lessons, p.id) })));
});

adminMembersRouter.get('/products/:id', async (req, res) => {
  const id = uuid.parse(req.params.id);
  // '*' traz as abas (members_tabs) quando o SQL das abas já rodou
  const { data: p } = await supabase.from('products').select('*').eq('id', id).maybeSingle();
  if (!p) throw new HttpError(404, 'Produto não encontrado');
  const [{ data: sections }, { data: modules }, { data: lessons }] = await Promise.all([
    supabase.from('member_sections').select('*').eq('product_id', id).order('sort', { ascending: true }),
    supabase.from('member_modules').select('id, section_id, title, subtitle, cover_url, sort').eq('product_id', id).order('sort', { ascending: true }),
    supabase.from('member_lessons').select('id, module_id, title, description, video_url, duration, attachments, sort').eq('product_id', id).order('sort', { ascending: true }),
  ]);
  const x = p as any;
  const tabs = memberTabs(x.members_tabs);
  res.json({
    id: x.id,
    number: x.number,
    name: x.name,
    image_url: x.image_url,
    members_enabled: x.members_enabled,
    members_banner_url: x.members_banner_url ?? null,
    code: productCode(x.number),
    tabs,
    tabs_ready: 'members_tabs' in x, // false = falta rodar o SQL das abas
    sections: ((sections ?? []) as any[]).map((s) => ({
      id: s.id,
      title: s.title,
      sort: s.sort,
      tab_id: tabs.some((t) => t.id === s.tab_id) ? s.tab_id : null,
      modules: ((modules ?? []) as any[]).filter((m) => m.section_id === s.id).map((m) => ({ ...m, lessons: ((lessons ?? []) as any[]).filter((l) => l.module_id === m.id) })),
    })),
  });
});

adminMembersRouter.put('/products/:id/enabled', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const enabled = z.boolean().parse(req.body?.enabled);
  must(await supabase.from('products').update({ members_enabled: enabled }).eq('id', id).select('id').single());
  res.json({ ok: true });
});

adminMembersRouter.put('/products/:id/banner', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const url = urlOrNull.parse(req.body?.url);
  must(await supabase.from('products').update({ members_banner_url: url }).eq('id', id).select('id').single());
  res.json({ ok: true });
});

// próximo número de ordem (novos itens vão para o fim)
async function nextSort(table: string, col: string, value: string) {
  const { data } = await supabase.from(table).select('sort').eq(col, value).order('sort', { ascending: false }).limit(1);
  return ((data?.[0] as any)?.sort ?? -1) + 1;
}

// ---------------------------------------------------------------- seções
const sectionSchema = z.object({ title: z.string().trim().min(1, 'Informe o nome da seção').max(80) });
adminMembersRouter.post('/products/:id/sections', async (req, res) => {
  const product_id = uuid.parse(req.params.id);
  const b = sectionSchema.parse(req.body);
  res.status(201).json(must(await supabase.from('member_sections').insert({ product_id, title: b.title, sort: await nextSort('member_sections', 'product_id', product_id) }).select('*').single()));
});
adminMembersRouter.put('/sections/:id', async (req, res) => {
  const b = sectionSchema.parse(req.body);
  res.json(must(await supabase.from('member_sections').update({ title: b.title }).eq('id', uuid.parse(req.params.id)).select('*').single()));
});
adminMembersRouter.delete('/sections/:id', async (req, res) => {
  await supabase.from('member_sections').delete().eq('id', uuid.parse(req.params.id));
  res.status(204).end();
});

// ---------------------------------------------------------------- abas (ex.: "Atividades de alfabetização")
const tabsMissing = (e: { message?: string } | null) => !!e && /members_tabs|tab_id|schema cache|column/i.test(e.message ?? '');
const SQL_TABS = 'Rode o SQL das abas (20261125000000_member_tabs.sql) no Supabase para usar as abas';
/** Salva a lista de abas na ordem enviada (criar, renomear, apagar e ordenar usam esta mesma rota). */
adminMembersRouter.put('/products/:id/tabs', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = z
    .object({ tabs: z.array(z.object({ id: z.string().regex(/^[a-z0-9]{4,24}$/).optional(), title: z.string().trim().min(1, 'Dê um nome à aba').max(40) })).max(20) })
    .parse(req.body);
  // aba nova ganha um id curto
  const tabs = b.tabs.map((t) => ({ id: t.id ?? crypto.randomBytes(5).toString('hex'), title: t.title }));
  const r = await supabase.from('products').update({ members_tabs: tabs }).eq('id', id).select('id').single();
  if (tabsMissing(r.error)) throw new HttpError(400, SQL_TABS);
  must(r);
  // seções de abas apagadas voltam para "sem aba" (continuam aparecendo em "Tudo")
  const { data: secs } = await supabase.from('member_sections').select('*').eq('product_id', id);
  const keep = new Set(tabs.map((t) => t.id));
  const orphans = ((secs ?? []) as any[]).filter((s) => s.tab_id && !keep.has(s.tab_id)).map((s) => s.id);
  if (orphans.length) await supabase.from('member_sections').update({ tab_id: null }).in('id', orphans);
  res.json({ tabs });
});
/** Coloca a seção numa aba (null = sem aba). */
adminMembersRouter.put('/sections/:id/tab', async (req, res) => {
  const sid = uuid.parse(req.params.id);
  const tabId = z.string().regex(/^[a-z0-9]{4,24}$/).nullable().parse(req.body?.tab_id ?? null);
  const { data: s } = await supabase.from('member_sections').select('product_id').eq('id', sid).maybeSingle();
  if (!s) throw new HttpError(404, 'Seção não encontrada');
  if (tabId) {
    const { data: p } = await supabase.from('products').select('*').eq('id', (s as any).product_id).maybeSingle();
    if (!memberTabs((p as any)?.members_tabs).some((t) => t.id === tabId)) throw new HttpError(400, 'Aba não encontrada');
  }
  const r = await supabase.from('member_sections').update({ tab_id: tabId }).eq('id', sid).select('id').single();
  if (tabsMissing(r.error)) throw new HttpError(400, SQL_TABS);
  must(r);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- PDF das aulas
/** Link do Google Drive → baixa o PDF e guarda uma cópia na área privada (só a área de membros usa). */
adminMembersRouter.post('/drive-pdf', async (req, res) => {
  const url = z.string().trim().max(1000).parse(req.body?.url);
  const org = currentOrgId();
  const owner = !org || (await isOwnerOrg(org));
  res.json(await importDrivePdf(url, owner ? '' : `${org}/`));
});

// ---------------------------------------------------------------- módulos
const moduleSchema = z.object({
  title: z.string().trim().min(1, 'Informe o nome do módulo').max(80),
  subtitle: z.string().trim().max(120).nullable().optional().transform((v) => v || null),
  cover_url: urlOrNull,
});
adminMembersRouter.post('/sections/:id/modules', async (req, res) => {
  const section_id = uuid.parse(req.params.id);
  const { data: s } = await supabase.from('member_sections').select('product_id').eq('id', section_id).maybeSingle();
  if (!s) throw new HttpError(404, 'Seção não encontrada');
  const b = moduleSchema.parse(req.body);
  res.status(201).json(must(await supabase.from('member_modules').insert({ ...b, section_id, product_id: (s as any).product_id, sort: await nextSort('member_modules', 'section_id', section_id) }).select('*').single()));
});
adminMembersRouter.put('/modules/:id', async (req, res) => {
  const b = moduleSchema.parse(req.body);
  res.json(must(await supabase.from('member_modules').update(b).eq('id', uuid.parse(req.params.id)).select('*').single()));
});
adminMembersRouter.delete('/modules/:id', async (req, res) => {
  await supabase.from('member_modules').delete().eq('id', uuid.parse(req.params.id));
  res.status(204).end();
});

// ---------------------------------------------------------------- aulas
const lessonSchema = z.object({
  title: z.string().trim().min(1, 'Informe o nome da aula').max(120),
  description: z.string().trim().max(5000).nullable().optional().transform((v) => v || null),
  video_url: urlOrNull,
  duration: z.string().trim().max(20).nullable().optional().transform((v) => v || null),
  // material: link comum (url) e/ou PDF guardado no sistema (file = caminho na área privada; url = link original do Drive, se houver)
  attachments: z
    .array(
      z
        .object({
          name: z.string().trim().min(1).max(120),
          url: z.string().trim().url().max(1000).or(z.literal('')).nullable().optional().transform((v) => v || null),
          file: z.string().regex(PDF_PATH, 'Arquivo inválido').nullable().optional().transform((v) => v || null),
        })
        .refine((a) => a.url || a.file, 'Informe o link ou envie o PDF'),
    )
    .max(20)
    .default([]),
});
/** PDFs da aula: só arquivos da pasta do próprio produtor (a Prime usa a pasta sem prefixo). */
async function checkFiles(b: { attachments: { file: string | null }[] }) {
  const org = currentOrgId();
  const owner = !org || (await isOwnerOrg(org));
  for (const a of b.attachments) {
    if (!a.file) continue;
    const prefix = a.file.includes('/members/') ? a.file.split('/')[0] : null;
    if (owner ? prefix && prefix !== org : prefix !== org) throw new HttpError(400, 'Arquivo de outra conta');
  }
  return b;
}
adminMembersRouter.post('/modules/:id/lessons', async (req, res) => {
  const module_id = uuid.parse(req.params.id);
  const { data: m } = await supabase.from('member_modules').select('product_id').eq('id', module_id).maybeSingle();
  if (!m) throw new HttpError(404, 'Módulo não encontrado');
  const b = await checkFiles(lessonSchema.parse(req.body));
  res.status(201).json(must(await supabase.from('member_lessons').insert({ ...b, module_id, product_id: (m as any).product_id, sort: await nextSort('member_lessons', 'module_id', module_id) }).select('*').single()));
});
adminMembersRouter.put('/lessons/:id', async (req, res) => {
  const b = await checkFiles(lessonSchema.parse(req.body));
  res.json(must(await supabase.from('member_lessons').update(b).eq('id', uuid.parse(req.params.id)).select('*').single()));
});
adminMembersRouter.delete('/lessons/:id', async (req, res) => {
  await supabase.from('member_lessons').delete().eq('id', uuid.parse(req.params.id));
  res.status(204).end();
});

// ---------------------------------------------------------------- ordem (setas ↑ ↓ no painel)
adminMembersRouter.post('/reorder', async (req, res) => {
  const b = z.object({ kind: z.enum(['sections', 'modules', 'lessons']), ids: z.array(uuid).min(1).max(200) }).parse(req.body);
  const table = { sections: 'member_sections', modules: 'member_modules', lessons: 'member_lessons' }[b.kind];
  await Promise.all(b.ids.map((id, i) => supabase.from(table).update({ sort: i }).eq('id', id)));
  res.json({ ok: true });
});

// ---------------------------------------------------------------- vitrine "Produtos adicionais" da área do aluno
adminMembersRouter.get('/offers', async (_req, res) => {
  res.json(await getMembersConfig());
});
adminMembersRouter.put('/offers', async (req, res) => {
  // só produtos da própria organização podem ir para a vitrine
  const ids: string[] = Array.isArray(req.body?.offers) ? req.body.offers.map((o: any) => String(o?.product_id ?? '')) : [];
  if (ids.length) {
    const { data } = await supabase.from('products').select('id').in('id', ids);
    if ((data ?? []).length !== new Set(ids).size) throw new HttpError(400, 'Produto inválido na vitrine');
  }
  res.json(await saveMembersConfig(req.body));
});
