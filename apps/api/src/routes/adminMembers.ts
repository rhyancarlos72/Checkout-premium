import { Router } from 'express';
import { z } from 'zod';
import { HttpError, must, productCode, supabase } from '../lib/core.js';
import { getMembersConfig, saveMembersConfig } from '../services/members.js';

/** Painel → Área de membros: seções, módulos e aulas de cada produto. (montado em /api/admin/members) */
export const adminMembersRouter = Router();
const uuid = z.string().uuid();
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
  const { data: p } = await supabase.from('products').select('id, number, name, image_url, members_enabled, members_banner_url').eq('id', id).maybeSingle();
  if (!p) throw new HttpError(404, 'Produto não encontrado');
  const [{ data: sections }, { data: modules }, { data: lessons }] = await Promise.all([
    supabase.from('member_sections').select('id, title, sort').eq('product_id', id).order('sort', { ascending: true }),
    supabase.from('member_modules').select('id, section_id, title, subtitle, cover_url, sort').eq('product_id', id).order('sort', { ascending: true }),
    supabase.from('member_lessons').select('id, module_id, title, description, video_url, duration, attachments, sort').eq('product_id', id).order('sort', { ascending: true }),
  ]);
  res.json({
    ...(p as any),
    code: productCode((p as any).number),
    sections: ((sections ?? []) as any[]).map((s) => ({
      ...s,
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
  attachments: z.array(z.object({ name: z.string().trim().min(1).max(120), url: z.string().trim().url().max(1000) })).max(20).default([]),
});
adminMembersRouter.post('/modules/:id/lessons', async (req, res) => {
  const module_id = uuid.parse(req.params.id);
  const { data: m } = await supabase.from('member_modules').select('product_id').eq('id', module_id).maybeSingle();
  if (!m) throw new HttpError(404, 'Módulo não encontrado');
  const b = lessonSchema.parse(req.body);
  res.status(201).json(must(await supabase.from('member_lessons').insert({ ...b, module_id, product_id: (m as any).product_id, sort: await nextSort('member_lessons', 'module_id', module_id) }).select('*').single()));
});
adminMembersRouter.put('/lessons/:id', async (req, res) => {
  const b = lessonSchema.parse(req.body);
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
  res.json(await saveMembersConfig(req.body));
});
