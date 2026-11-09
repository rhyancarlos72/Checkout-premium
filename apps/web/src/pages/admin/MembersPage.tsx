import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowLeft, ArrowUp, ExternalLink, Lock, Sparkles, FileText, GraduationCap, Link2, Pencil, Plus, PlayCircle, Trash2, Video, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ImageUpload } from '@/components/ImageUpload';
import { Badge, Button, Card, cn, EmptyState, Field, Input, Modal, PageLoader, Textarea, useToast } from '@/components/ui';
import { adminApi, ApiError } from '@/lib/api';
import { videoSource } from '@/lib/video';
import { PageHeader } from './AdminApp';

interface ProductRow { id: string; code: string | null; name: string; image_url: string | null; active: boolean; members_enabled: boolean; modules: number; lessons: number }
interface Lesson { id: string; module_id: string; title: string; description: string | null; video_url: string | null; duration: string | null; attachments: { name: string; url: string }[]; sort: number }
interface Module { id: string; section_id: string; title: string; subtitle: string | null; cover_url: string | null; sort: number; lessons: Lesson[] }
interface Section { id: string; title: string; sort: number; modules: Module[] }
interface Detail { id: string; code: string | null; name: string; image_url: string | null; members_enabled: boolean; members_banner_url: string | null; sections: Section[] }

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Não foi possível salvar');

export default function MembersPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<'cursos' | 'ofertas'>('cursos');
  const list = useQuery({ queryKey: ['members-admin', 'products'], queryFn: () => adminApi.get<ProductRow[]>('/members/products') });
  return (
    <>
      <PageHeader
        title="Área de membros"
        subtitle="Monte seus cursos em seções, módulos e aulas. Quem compra (inclusive pelo order bump) recebe o acesso na hora; os outros cursos aparecem bloqueados em “Cursos adicionais”."
        action={
          <a href="/membros/login" target="_blank" rel="noopener noreferrer">
            <Button variant="secondary" className="whitespace-nowrap"><ExternalLink className="h-4 w-4" /> Abrir área do aluno</Button>
          </a>
        }
      />
      {!selected && (
        <div className="mb-6 inline-flex rounded-xl border border-zinc-200 bg-white p-1">
          {([['cursos', 'Cursos'], ['ofertas', 'Produtos adicionais']] as const).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={cn('rounded-lg px-4 py-2 text-sm font-semibold transition', tab === k ? 'bg-blue-600 text-white shadow' : 'text-zinc-500 hover:text-zinc-800')}>
              {l}
            </button>
          ))}
        </div>
      )}
      {selected ? (
        <CourseEditor productId={selected} onBack={() => setSelected(null)} />
      ) : tab === 'ofertas' ? (
        <OffersEditor products={list.data ?? []} />
      ) : list.isLoading ? (
        <PageLoader />
      ) : !list.data?.length ? (
        <Card><EmptyState icon={<GraduationCap className="h-6 w-6" />} title="Nenhum produto" text="Cadastre um produto em Produtos e depois monte o curso dele aqui." /></Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[...list.data].sort((a, b) => Number(b.members_enabled) - Number(a.members_enabled)).map((p) => (
            <ProductCard key={p.id} p={p} onOpen={() => setSelected(p.id)} />
          ))}
        </div>
      )}
    </>
  );
}

function ProductCard({ p, onOpen }: { p: ProductRow; onOpen: () => void }) {
  return (
    <Card className="flex flex-col">
      <div className="flex items-start gap-3">
        {p.image_url ? <img src={p.image_url} alt="" className="h-14 w-14 rounded-xl object-cover" /> : <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-blue-50 text-blue-600"><GraduationCap className="h-6 w-6" /></div>}
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{p.name}</p>
          <p className="text-xs text-zinc-500">{p.code ? `ID: ${p.code} · ` : ''}{p.modules} módulos · {p.lessons} aulas</p>
          <div className="mt-1.5">{p.members_enabled ? <Badge tone="paid">Área ativa</Badge> : <Badge tone="expired">Desligada</Badge>}</div>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-zinc-100 pt-4">
        <p className="text-xs leading-snug text-zinc-500">{p.members_enabled ? 'Entrega: área de membros' : 'Entrega por link. Para usar a área, escolha “Área de membros” em Produtos → editar → Entrega.'}</p>
        <Button size="sm" className="shrink-0 whitespace-nowrap" variant={p.members_enabled ? 'primary' : 'secondary'} onClick={onOpen}><Pencil className="h-3.5 w-3.5" /> Montar curso</Button>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ editor do curso
function CourseEditor({ productId, onBack }: { productId: string; onBack: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['members-admin', 'product', productId];
  const q = useQuery({ queryKey: key, queryFn: () => adminApi.get<Detail>(`/members/products/${productId}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['members-admin'] });
  const [newSection, setNewSection] = useState('');
  const [editingModule, setEditingModule] = useState<{ sectionId: string; module: Module | null } | null>(null);

  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: refresh,
    onError: (e) => toast.err(errMsg(e)),
  });
  const move = (kind: 'sections' | 'modules' | 'lessons', ids: string[], i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    const next = [...ids];
    [next[i], next[j]] = [next[j], next[i]];
    run.mutate(() => adminApi.post('/members/reorder', { kind, ids: next }));
  };

  if (q.isLoading || !q.data) return <PageLoader />;
  const d = q.data;
  // o modal sempre mostra a versão mais nova do módulo (aulas adicionadas aparecem na hora)
  const liveModule = editingModule?.module ? d.sections.flatMap((s) => s.modules).find((m) => m.id === editingModule.module!.id) ?? null : null;

  return (
    <div className="space-y-6">
      {toast.node}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="h-4 w-4" /> Produtos</Button>
        <h2 className="font-display text-xl font-bold tracking-tight">{d.name}</h2>
        {d.members_enabled ? <Badge tone="paid">Entrega pela área de membros</Badge> : <Badge tone="expired">Entrega por link: escolha “Área de membros” em Produtos → Entrega para liberar aos compradores</Badge>}
      </div>

      <Card>
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_320px] md:items-center">
          <div>
            <p className="font-semibold">Banner de destaque</p>
            <p className="mt-1 text-sm text-zinc-500">Imagem grande no topo da área do aluno, estilo Netflix (horizontal, 1920×1080 px). Sem banner, usamos a capa do primeiro módulo.</p>
            <div className="mt-3"><ImageUpload kind="banner" label="Imagem do banner" value={d.members_banner_url} onChange={(url) => run.mutate(() => adminApi.put(`/members/products/${productId}/banner`, { url }))} /></div>
          </div>
          <div className="relative aspect-video overflow-hidden rounded-xl bg-[#07080c]">
            {(d.members_banner_url || d.sections[0]?.modules[0]?.cover_url) && <img src={(d.members_banner_url || d.sections[0]?.modules[0]?.cover_url)!} alt="" className="absolute inset-0 h-full w-full object-cover" />}
            <div className="absolute inset-0 bg-gradient-to-r from-[#07080c] via-[#07080c]/60 to-transparent" />
            <div className="absolute inset-0 bg-gradient-to-t from-[#07080c] to-transparent" />
            <div className="absolute bottom-3 left-3 right-10 text-white">
              <p className="text-[9px] font-bold uppercase tracking-[.25em] text-blue-400">Curso</p>
              <p className="line-clamp-2 text-[15px] font-extrabold leading-tight">{d.name}</p>
              <span className="mt-1.5 inline-flex rounded bg-white px-2 py-0.5 text-[10px] font-bold text-black">▶ Assistir</span>
            </div>
          </div>
        </div>
      </Card>

      {d.sections.map((s, si) => (
        <Card key={s.id}>
          <SectionHeader
            section={s}
            onRename={(title) => run.mutate(() => adminApi.put(`/members/sections/${s.id}`, { title }))}
            onDelete={() => confirm(`Excluir a seção “${s.title}” com todos os módulos e aulas?`) && run.mutate(() => adminApi.del(`/members/sections/${s.id}`))}
            onUp={() => move('sections', d.sections.map((x) => x.id), si, -1)}
            onDown={() => move('sections', d.sections.map((x) => x.id), si, 1)}
          />
          <div className="mt-4 flex gap-4 overflow-x-auto pb-2">
            {s.modules.map((m, mi) => (
              <div key={m.id} className="w-[140px] shrink-0">
                <button onClick={() => setEditingModule({ sectionId: s.id, module: m })} className="group block w-full overflow-hidden rounded-xl border border-zinc-200 text-left transition hover:border-blue-400 hover:shadow-md">
                  <div className="relative aspect-[2/3] bg-gradient-to-b from-[#0b1a44] to-black">
                    {m.cover_url ? <img src={m.cover_url} alt="" className="h-full w-full object-cover" /> : <span className="absolute inset-0 flex items-center justify-center px-2 text-center text-[12px] font-bold uppercase tracking-wider text-white">{m.title}</span>}
                    <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition group-hover:bg-black/40 group-hover:opacity-100"><Pencil className="h-5 w-5 text-white" /></span>
                  </div>
                  <div className="px-2 py-2">
                    <p className="truncate text-[13px] font-semibold">{m.title}</p>
                    <p className="text-[11px] text-zinc-500">{m.lessons.length} aulas</p>
                  </div>
                </button>
                <div className="mt-1 flex justify-center gap-1">
                  <IconBtn label="Mover para a esquerda" onClick={() => move('modules', s.modules.map((x) => x.id), mi, -1)}><ArrowUp className="h-3.5 w-3.5 -rotate-90" /></IconBtn>
                  <IconBtn label="Mover para a direita" onClick={() => move('modules', s.modules.map((x) => x.id), mi, 1)}><ArrowDown className="h-3.5 w-3.5 -rotate-90" /></IconBtn>
                </div>
              </div>
            ))}
            <button onClick={() => setEditingModule({ sectionId: s.id, module: null })} className="flex aspect-[2/3] w-[140px] shrink-0 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-zinc-300 text-sm font-semibold text-zinc-500 transition hover:border-blue-400 hover:text-blue-600">
              <Plus className="h-6 w-6" /> Novo módulo
            </button>
          </div>
        </Card>
      ))}

      <Card>
        <form
          className="flex flex-col gap-3 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newSection.trim()) return;
            run.mutate(() => adminApi.post(`/members/products/${productId}/sections`, { title: newSection.trim() }));
            setNewSection('');
          }}
        >
          <Input value={newSection} onChange={(e) => setNewSection(e.target.value)} placeholder={d.sections.length ? `Sessão ${d.sections.length + 1}` : 'Sessão 1 (ex.: Comece aqui)'} aria-label="Nome da nova seção" />
          <Button type="submit" className="shrink-0"><Plus className="h-4 w-4" /> Nova seção</Button>
        </form>
        {!d.sections.length && <p className="mt-3 text-sm text-zinc-500">Comece criando uma seção (ex.: “Sessão 1”). Depois adicione os módulos com capa vertical e as aulas de cada módulo.</p>}
      </Card>

      {editingModule && (
        <ModuleModal
          sectionId={editingModule.sectionId}
          module={editingModule.module ? (liveModule ?? editingModule.module) : null}
          onClose={() => setEditingModule(null)}
          onSaved={(m) => (refresh(), setEditingModule({ sectionId: editingModule.sectionId, module: m }))}
          onDeleted={() => (refresh(), setEditingModule(null))}
          onMoveLesson={(ids, i, dir) => move('lessons', ids, i, dir)}
        />
      )}
    </div>
  );
}

function IconBtn({ label, onClick, children, danger }: { label: string; onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className={cn('rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-100', danger ? 'hover:text-red-600' : 'hover:text-zinc-700')}>
      {children}
    </button>
  );
}

function SectionHeader({ section, onRename, onDelete, onUp, onDown }: { section: Section; onRename: (t: string) => void; onDelete: () => void; onUp: () => void; onDown: () => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(section.title);
  useEffect(() => setTitle(section.title), [section.title]);
  return (
    <div className="flex items-center gap-3">
      <span className="h-8 w-1 rounded-full bg-blue-500" />
      {editing ? (
        <form className="flex flex-1 gap-2" onSubmit={(e) => (e.preventDefault(), title.trim() && onRename(title.trim()), setEditing(false))}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus aria-label="Nome da seção" />
          <Button type="submit" size="sm">Salvar</Button>
        </form>
      ) : (
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-lg font-bold">{section.title}</p>
          <p className="text-xs text-zinc-500">{section.modules.length} {section.modules.length === 1 ? 'módulo' : 'módulos'}</p>
        </div>
      )}
      <div className="flex shrink-0">
        <IconBtn label="Subir seção" onClick={onUp}><ArrowUp className="h-4 w-4" /></IconBtn>
        <IconBtn label="Descer seção" onClick={onDown}><ArrowDown className="h-4 w-4" /></IconBtn>
        <IconBtn label="Renomear" onClick={() => setEditing(true)}><Pencil className="h-4 w-4" /></IconBtn>
        <IconBtn label="Excluir seção" danger onClick={onDelete}><Trash2 className="h-4 w-4" /></IconBtn>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ módulo (capa + aulas)
function ModuleModal({ sectionId, module, onClose, onSaved, onDeleted, onMoveLesson }: { sectionId: string; module: Module | null; onClose: () => void; onSaved: (m: Module) => void; onDeleted: () => void; onMoveLesson: (ids: string[], i: number, dir: -1 | 1) => void }) {
  const toast = useToast();
  const [f, setF] = useState({ title: module?.title ?? '', subtitle: module?.subtitle ?? '', cover_url: module?.cover_url ?? '' });
  const [lesson, setLesson] = useState<Lesson | 'new' | null>(null);
  useEffect(() => {
    if (module) setF({ title: module.title, subtitle: module.subtitle ?? '', cover_url: module.cover_url ?? '' });
  }, [module?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: () => (module ? adminApi.put<Module>(`/members/modules/${module.id}`, f) : adminApi.post<Module>(`/members/sections/${sectionId}/modules`, f)),
    onSuccess: (m) => (toast.ok(module ? 'Módulo salvo' : 'Módulo criado. Agora adicione as aulas.'), onSaved({ ...m, lessons: module?.lessons ?? [] })),
    onError: (e) => toast.err(errMsg(e)),
  });
  const del = useMutation({ mutationFn: () => adminApi.del(`/members/modules/${module!.id}`), onSuccess: onDeleted, onError: (e) => toast.err(errMsg(e)) });
  const delLesson = useMutation({ mutationFn: (id: string) => adminApi.del(`/members/lessons/${id}`), onSuccess: () => module && onSaved(module), onError: (e) => toast.err(errMsg(e)) });

  return (
    <Modal open onClose={onClose} title={module ? `Módulo: ${module.title}` : 'Novo módulo'} wide>
      {toast.node}
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_180px]">
        <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
          <Field label="Nome do módulo" hint="Ex.: Comece aqui, Facebook Ads do zero"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required /></Field>
          <Field label="Legenda (aparece embaixo da capa)" hint="Ex.: Preparando a base"><Input value={f.subtitle} onChange={(e) => setF({ ...f, subtitle: e.target.value })} /></Field>
          <ImageUpload kind="poster" label="Capa vertical (formato 2:3, ex.: 600×900 px)" value={f.cover_url} onChange={(url) => setF({ ...f, cover_url: url })} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={save.isPending}>{module ? 'Salvar módulo' : 'Criar módulo'}</Button>
            {module && <Button type="button" variant="danger" onClick={() => confirm('Excluir este módulo e todas as aulas dele?') && del.mutate()}><Trash2 className="h-4 w-4" /> Excluir</Button>}
          </div>
        </form>
        <div className="hidden md:block">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Prévia</p>
          <div className="overflow-hidden rounded-xl border border-zinc-800 bg-[#0e1016] text-white">
            <div className="relative aspect-[2/3] bg-gradient-to-b from-[#0b1a44] to-black">
              {f.cover_url ? <img src={f.cover_url} alt="" className="h-full w-full object-cover" /> : <span className="absolute inset-0 flex items-center justify-center px-3 text-center text-sm font-bold uppercase tracking-wider">{f.title || 'Módulo'}</span>}
            </div>
            <p className="px-2 py-2.5 text-center text-[12px] font-semibold">{f.subtitle || f.title || 'Legenda'}</p>
          </div>
        </div>
      </div>

      {module && (
        <div className="mt-8 border-t border-zinc-100 pt-6">
          <div className="mb-3 flex items-center justify-between">
            <p className="font-semibold">Aulas ({module.lessons.length})</p>
            <Button size="sm" onClick={() => setLesson('new')}><Plus className="h-4 w-4" /> Nova aula</Button>
          </div>
          {!module.lessons.length ? (
            <p className="rounded-xl border border-dashed border-zinc-300 p-5 text-center text-sm text-zinc-500">Nenhuma aula ainda. Adicione a primeira com o link do vídeo (YouTube, Vimeo, Panda, Google Drive ou arquivo .mp4).</p>
          ) : (
            <ol className="divide-y divide-zinc-100 rounded-xl border border-zinc-200">
              {module.lessons.map((l, i) => (
                <li key={l.id} className="flex items-center gap-3 px-3 py-2.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-50 text-xs font-bold text-blue-600">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{l.title}</p>
                    <p className="flex items-center gap-2 text-[11.5px] text-zinc-500">
                      {l.video_url ? <><Video className="h-3 w-3" /> vídeo</> : 'sem vídeo'}
                      {l.duration ? ` · ${l.duration}` : ''}
                      {l.attachments.length ? <> · <FileText className="h-3 w-3" /> {l.attachments.length} material(is)</> : null}
                    </p>
                  </div>
                  <IconBtn label="Subir" onClick={() => onMoveLesson(module.lessons.map((x) => x.id), i, -1)}><ArrowUp className="h-4 w-4" /></IconBtn>
                  <IconBtn label="Descer" onClick={() => onMoveLesson(module.lessons.map((x) => x.id), i, 1)}><ArrowDown className="h-4 w-4" /></IconBtn>
                  <IconBtn label="Editar aula" onClick={() => setLesson(l)}><Pencil className="h-4 w-4" /></IconBtn>
                  <IconBtn label="Excluir aula" danger onClick={() => confirm(`Excluir a aula “${l.title}”?`) && delLesson.mutate(l.id)}><Trash2 className="h-4 w-4" /></IconBtn>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {lesson && module && <LessonModal moduleId={module.id} lesson={lesson === 'new' ? null : lesson} onClose={() => setLesson(null)} onSaved={() => (setLesson(null), onSaved(module))} />}
    </Modal>
  );
}

function LessonModal({ moduleId, lesson, onClose, onSaved }: { moduleId: string; lesson: Lesson | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    title: lesson?.title ?? '',
    video_url: lesson?.video_url ?? '',
    duration: lesson?.duration ?? '',
    description: lesson?.description ?? '',
    attachments: lesson?.attachments ?? ([] as { name: string; url: string }[]),
  });
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, attachments: f.attachments.filter((a) => a.name.trim() && a.url.trim()) };
      return lesson ? adminApi.put(`/members/lessons/${lesson.id}`, body) : adminApi.post(`/members/modules/${moduleId}/lessons`, body);
    },
    onSuccess: onSaved,
    onError: (e) => toast.err(errMsg(e)),
  });
  const src = videoSource(f.video_url);
  return (
    <Modal open onClose={onClose} title={lesson ? 'Editar aula' : 'Nova aula'} wide>
      {toast.node}
      <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
        <Field label="Título da aula"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required /></Field>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_140px]">
          <Field label="Link do vídeo" hint="YouTube, Vimeo, Panda Video, Google Drive ou link direto .mp4">
            <Input value={f.video_url} onChange={(e) => setF({ ...f, video_url: e.target.value })} placeholder="https://www.youtube.com/watch?v=…" icon={<PlayCircle className="h-4 w-4" />} />
          </Field>
          <Field label="Duração"><Input value={f.duration} onChange={(e) => setF({ ...f, duration: e.target.value })} placeholder="12 min" /></Field>
        </div>
        {f.video_url && !src && <p className="text-sm text-red-600">Use um link que comece com https://</p>}
        {src && (
          <div className="overflow-hidden rounded-xl border border-zinc-200 bg-black">
            {src.kind === 'iframe' ? <div className="relative aspect-video"><iframe src={src.src} title="Prévia" className="absolute inset-0 h-full w-full" allow="encrypted-media; fullscreen; picture-in-picture" allowFullScreen /></div> : <video src={src.src} controls className="aspect-video w-full" />}
          </div>
        )}
        <Field label="Descrição / conteúdo da aula (opcional)"><Textarea rows={4} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium">Materiais para baixar (opcional)</p>
            <Button type="button" size="sm" variant="secondary" onClick={() => setF({ ...f, attachments: [...f.attachments, { name: '', url: '' }] })}><Link2 className="h-3.5 w-3.5" /> Adicionar link</Button>
          </div>
          <div className="space-y-2">
            {f.attachments.map((a, i) => (
              <div key={i} className="flex gap-2">
                <Input value={a.name} onChange={(e) => setF({ ...f, attachments: f.attachments.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} placeholder="Nome (ex.: Apostila PDF)" aria-label="Nome do material" />
                <Input value={a.url} onChange={(e) => setF({ ...f, attachments: f.attachments.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} placeholder="https://drive.google.com/…" aria-label="Link do material" />
                <IconBtn label="Remover material" danger onClick={() => setF({ ...f, attachments: f.attachments.filter((_, j) => j !== i) })}><X className="h-4 w-4" /></IconBtn>
              </div>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={save.isPending}>{lesson ? 'Salvar aula' : 'Adicionar aula'}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ vitrine de produtos adicionais
interface Offer { product_id: string; title: string | null; description: string | null; cover_url: string | null; badge: string | null }
interface OffersConfig { offersTitle: string; offersSubtitle: string; offers: Offer[] }

function OffersEditor({ products }: { products: ProductRow[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['members-admin', 'offers'], queryFn: () => adminApi.get<OffersConfig>('/members/offers') });
  const [cfg, setCfg] = useState<OffersConfig | null>(null);
  const [pick, setPick] = useState('');
  useEffect(() => {
    if (q.data && !cfg) setCfg(q.data);
  }, [q.data, cfg]);
  const save = useMutation({
    mutationFn: (v: OffersConfig) => adminApi.put<OffersConfig>('/members/offers', v),
    onSuccess: (v) => (setCfg(v), qc.setQueryData(['members-admin', 'offers'], v), toast.ok('Vitrine salva')),
    onError: (e) => toast.err(errMsg(e)),
  });
  if (!cfg) return <PageLoader />;
  const byId = new Map(products.map((p) => [p.id, p]));
  const set = (patch: Partial<OffersConfig>) => setCfg({ ...cfg, ...patch });
  const setOffer = (i: number, patch: Partial<Offer>) => set({ offers: cfg.offers.map((o, j) => (j === i ? { ...o, ...patch } : o)) });
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= cfg.offers.length) return;
    const next = [...cfg.offers];
    [next[i], next[j]] = [next[j], next[i]];
    set({ offers: next });
  };
  const available = products.filter((p) => p.active && !cfg.offers.some((o) => o.product_id === p.id));

  return (
    <div className="space-y-6">
      {toast.node}
      <Card>
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-600"><Sparkles className="h-5 w-5" /></span>
          <div>
            <p className="font-semibold">Vitrine de produtos adicionais</p>
            <p className="mt-1 text-sm text-zinc-500">Escolha o que oferecer embaixo dos cursos do aluno. Cada produto aparece bloqueado, com o botão “Desbloquear” que leva ao checkout dele. Quem já comprou não vê a oferta. Sem nenhum produto escolhido, a vitrine mostra automaticamente os cursos com área de membros que a pessoa ainda não tem.</p>
          </div>
        </div>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <Field label="Título da vitrine"><Input value={cfg.offersTitle} onChange={(e) => set({ offersTitle: e.target.value })} placeholder="Cursos adicionais" /></Field>
          <Field label="Subtítulo"><Input value={cfg.offersSubtitle} onChange={(e) => set({ offersSubtitle: e.target.value })} placeholder="Libere mais conteúdos" /></Field>
        </div>
      </Card>

      {cfg.offers.map((o, i) => {
        const p = byId.get(o.product_id);
        return (
          <Card key={o.product_id}>
            <div className="grid gap-5 md:grid-cols-[150px_minmax(0,1fr)]">
              <div className="mx-auto w-[150px] overflow-hidden rounded-xl bg-[#101219] text-white ring-1 ring-zinc-800">
                <div className="relative aspect-[2/3] bg-gradient-to-b from-[#0b2a8a] to-black">
                  {(o.cover_url || p?.image_url) && <img src={(o.cover_url || p?.image_url)!} alt="" className="h-full w-full object-cover brightness-[.45]" />}
                  <span className="absolute left-2 top-2 rounded bg-amber-400 px-1.5 py-0.5 text-[9px] font-black uppercase text-black">{o.badge || 'Exclusivo'}</span>
                  <span className="absolute inset-0 flex items-center justify-center"><span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/60 ring-1 ring-amber-300/50"><Lock className="h-4 w-4 text-amber-300" /></span></span>
                </div>
                <div className="px-2 py-2.5 text-center">
                  <p className="line-clamp-2 text-[12px] font-semibold">{o.title || p?.name || 'Produto'}</p>
                  <span className="mt-1.5 inline-block rounded bg-amber-400 px-2 py-0.5 text-[10px] font-bold text-black">Desbloquear</span>
                </div>
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="min-w-0 truncate font-semibold">{p ? `${p.name}${p.code ? ` · ID: ${p.code}` : ''}` : 'Produto removido'}</p>
                  <div className="flex shrink-0">
                    <IconBtn label="Subir" onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></IconBtn>
                    <IconBtn label="Descer" onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></IconBtn>
                    <IconBtn label="Remover da vitrine" danger onClick={() => set({ offers: cfg.offers.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></IconBtn>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
                  <Field label="Título (vazio = nome do produto)"><Input value={o.title ?? ''} onChange={(e) => setOffer(i, { title: e.target.value })} placeholder={p?.name} /></Field>
                  <Field label="Selo"><Input value={o.badge ?? ''} onChange={(e) => setOffer(i, { badge: e.target.value })} placeholder="Exclusivo" maxLength={20} /></Field>
                </div>
                <Field label="Frase curta (opcional)"><Input value={o.description ?? ''} onChange={(e) => setOffer(i, { description: e.target.value })} placeholder="Ex.: +300 modelos prontos para vender mais" maxLength={300} /></Field>
                <ImageUpload kind="poster" label="Capa vertical (vazio = capa do curso ou imagem do produto)" value={o.cover_url} onChange={(url) => setOffer(i, { cover_url: url })} />
              </div>
            </div>
          </Card>
        );
      })}

      <Card>
        <div className="flex flex-col gap-3 sm:flex-row">
          <select value={pick} onChange={(e) => setPick(e.target.value)} className="h-11 flex-1 rounded-xl border border-zinc-200 bg-white px-3 text-sm" aria-label="Produto para oferecer">
            <option value="">Escolha um produto para oferecer…</option>
            {available.map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.code ? ` · ID: ${p.code}` : ''}{p.members_enabled ? ' (área de membros)' : ''}</option>
            ))}
          </select>
          <Button type="button" disabled={!pick} onClick={() => (set({ offers: [...cfg.offers, { product_id: pick, title: null, description: null, cover_url: null, badge: null }] }), setPick(''))}>
            <Plus className="h-4 w-4" /> Adicionar à vitrine
          </Button>
        </div>
        {!cfg.offers.length && <p className="mt-3 text-sm text-zinc-500">Nenhum produto escolhido: a vitrine está no modo automático.</p>}
      </Card>

      <div className="sticky bottom-4 z-10 flex justify-end">
        <Button size="lg" loading={save.isPending} onClick={() => save.mutate(cfg)} className="shadow-xl">Salvar vitrine</Button>
      </div>
    </div>
  );
}
