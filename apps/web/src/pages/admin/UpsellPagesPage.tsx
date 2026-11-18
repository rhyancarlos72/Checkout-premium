import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, ExternalLink, Film, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, cn, EmptyState, Field, Input, Modal, PageLoader, Select, Switch, Textarea, useToast } from '@/components/ui';
import { adminApi, ApiError } from '@/lib/api';
import { brl } from '@/lib/format';
import { supabase } from '@/lib/supabase';
import { PageHeader } from './AdminApp';

/**
 * Páginas de vendas de upsell (/oferta/slug): título + vídeo (VSL) + botão; o pagamento acontece na própria página.
 * O vídeo é comprimido NO NAVEGADOR antes de subir (720p + 480p + capa) para a página abrir e tocar rápido.
 */
interface Page {
  id: string;
  slug: string;
  checkout_id: string;
  title: string;
  headline: string;
  subheadline: string | null;
  video_url: string | null;
  video_sd_url: string | null;
  poster_url: string | null;
  cta_text: string;
  bullets: string[];
  guarantee: string | null;
  button_delay_seconds: number;
  active: boolean;
  url: string;
  checkout: { slug: string; name: string } | null;
  stats?: { views: number; clicks: number; orders: number; paid: number; revenue_cents: number };
}
interface CheckoutOpt { id: string; slug: string; name: string; product: string | null; club: boolean }
interface Data { ready: boolean; sql_hint: string | null; pages: Page[]; checkouts: CheckoutOpt[] }
type Form = Omit<Page, 'id' | 'url' | 'checkout' | 'stats'>;

const empty = (checkoutId = ''): Form => ({
  slug: '',
  checkout_id: checkoutId,
  title: '',
  headline: '',
  subheadline: '',
  video_url: null,
  video_sd_url: null,
  poster_url: null,
  cta_text: 'Quero entrar agora',
  bullets: [],
  guarantee: '',
  button_delay_seconds: 0,
  active: true,
});
const slugify = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

export default function UpsellPagesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error } = useQuery({ queryKey: ['upsell-pages'], queryFn: () => adminApi.get<Data>('/upsell-pages') });
  const [editing, setEditing] = useState<{ id: string | null; form: Form } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['upsell-pages'] });
  const remove = useMutation({
    mutationFn: (p: Page) => adminApi.del(`/upsell-pages/${p.id}`),
    onSuccess: () => (toast.ok('Página apagada'), refresh()),
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro'),
  });
  const toggle = useMutation({
    mutationFn: (p: Page) => adminApi.put(`/upsell-pages/${p.id}`, { ...formOf(p), active: !p.active }),
    onSuccess: refresh,
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro'),
  });

  if (isLoading) return <PageLoader />;
  if (error || !data) return <Card><p className="text-sm text-red-600">{error instanceof ApiError ? error.message : 'Não foi possível carregar.'}</p></Card>;

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      /* ignore */
    }
    setCopied(url);
    setTimeout(() => setCopied(null), 2000);
  };
  const club = data.checkouts.find((c) => c.club);

  return (
    <>
      {toast.node}
      <PageHeader
        title="Páginas upsell"
        subtitle="Página de vendas curta: vídeo da oferta + botão, e o Pix na própria página. Depois de pagar, a pessoa já entra na área de membros."
        action={<Button disabled={!data.ready} onClick={() => setEditing({ id: null, form: empty(club?.id ?? '') })}><Plus className="h-4 w-4" /> Nova página</Button>}
      />
      {!data.ready && (
        <Card className="mb-4 border-amber-300 bg-amber-50">
          <p className="text-sm font-medium text-amber-800">{data.sql_hint}</p>
        </Card>
      )}
      {!data.pages.length ? (
        <Card>
          <EmptyState icon={<Film className="h-6 w-6" />} title="Nenhuma página ainda" text="Crie a página do Clube: suba o vídeo da oferta, escreva o título e o texto do botão." action={data.ready ? <Button onClick={() => setEditing({ id: null, form: empty(club?.id ?? '') })}><Plus className="h-4 w-4" /> Criar página</Button> : undefined} />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.pages.map((p) => {
            const s = p.stats ?? { views: 0, clicks: 0, orders: 0, paid: 0, revenue_cents: 0 };
            return (
              <Card key={p.id}>
                <div className="flex gap-4">
                  <div className="relative hidden h-24 w-40 shrink-0 overflow-hidden rounded-xl bg-zinc-900 sm:block">
                    {p.poster_url ? <img src={p.poster_url} alt="" className="h-full w-full object-cover" /> : <Film className="absolute inset-0 m-auto h-6 w-6 text-zinc-500" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate font-semibold">{p.title}</h3>
                      <Badge tone={p.active ? 'active' : 'off'}>{p.active ? 'No ar' : 'Pausada'}</Badge>
                    </div>
                    <p className="mt-0.5 truncate text-sm text-zinc-500">{p.checkout?.name ?? '—'} · {p.video_url ? 'com vídeo' : 'sem vídeo'}</p>
                    <button type="button" onClick={() => copy(p.url)} className="mt-1 flex max-w-full items-center gap-1.5 truncate text-sm text-blue-600 hover:underline">
                      {copied === p.url ? <Check className="h-3.5 w-3.5 shrink-0" /> : <Copy className="h-3.5 w-3.5 shrink-0" />} <span className="truncate">{p.url}</span>
                    </button>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 text-center sm:grid-cols-5">
                  {[
                    ['Visitas', s.views],
                    ['Cliques', s.clicks],
                    ['Pix gerados', s.orders],
                    ['Pagos', s.paid],
                    ['Conversão', `${s.views ? Math.round((s.paid / s.views) * 1000) / 10 : 0}%`],
                  ].map(([k, val]) => (
                    <div key={k as string} className="rounded-lg bg-zinc-50 px-2 py-1.5">
                      <p className="text-[11px] text-zinc-500">{k}</p>
                      <p className="text-sm font-semibold tabular-nums">{val}</p>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-right text-xs text-zinc-500">Faturamento: <b className="pv">{brl(s.revenue_cents)}</b></p>
                <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                  <Switch checked={p.active} onChange={() => toggle.mutate(p)} label={p.active ? 'No ar' : 'Pausada'} />
                  <a href={p.url} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm text-zinc-600 hover:bg-zinc-100"><ExternalLink className="h-3.5 w-3.5" /> Abrir</a>
                  <Button size="sm" variant="secondary" onClick={() => setEditing({ id: p.id, form: formOf(p) })}><Pencil className="h-3.5 w-3.5" /> Editar</Button>
                  <Button size="sm" variant="ghost" onClick={() => confirm(`Apagar a página "${p.title}"? O link deixa de funcionar.`) && remove.mutate(p)}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {editing && <Editor initial={editing.form} id={editing.id} checkouts={data.checkouts} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), refresh(), toast.ok('Página salva'))} />}
    </>
  );
}

const formOf = (p: Page): Form => ({
  slug: p.slug,
  checkout_id: p.checkout_id,
  title: p.title,
  headline: p.headline,
  subheadline: p.subheadline ?? '',
  video_url: p.video_url,
  video_sd_url: p.video_sd_url,
  poster_url: p.poster_url,
  cta_text: p.cta_text,
  bullets: p.bullets ?? [],
  guarantee: p.guarantee ?? '',
  button_delay_seconds: p.button_delay_seconds ?? 0,
  active: p.active,
});

// ------------------------------------------------------------------ editor
function Editor({ initial, id, checkouts, onClose, onSaved }: { initial: Form; id: string | null; checkouts: CheckoutOpt[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Form>(initial);
  const [slugTouched, setSlugTouched] = useState(Boolean(id));
  const [err, setErr] = useState<string | null>(null);
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));
  const save = useMutation({
    mutationFn: () => (id ? adminApi.put(`/upsell-pages/${id}`, f) : adminApi.post('/upsell-pages', f)),
    onSuccess: onSaved,
    onError: (e) => setErr(e instanceof ApiError ? e.message : 'Erro ao salvar'),
  });
  const bullets = [...f.bullets, '', '', '', ''].slice(0, 4);

  return (
    <Modal open onClose={onClose} title={id ? 'Editar página upsell' : 'Nova página upsell'} wide>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-4">
          <Field label="Produto (checkout que cobra)" hint="O preço e o Pix vêm deste checkout. Para o Clube, escolha o checkout do Clube (Pix Automático).">
            <Select value={f.checkout_id} onChange={(e) => set({ checkout_id: e.target.value })}>
              <option value="">Escolha…</option>
              {checkouts.map((c) => (
                <option key={c.id} value={c.id}>{c.product ?? c.name}{c.club ? ' (Clube)' : ''} · {c.name} ({c.slug})</option>
              ))}
            </Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nome da página (só no painel)">
              <Input value={f.title} onChange={(e) => set({ title: e.target.value, ...(slugTouched ? {} : { slug: slugify(e.target.value) }) })} placeholder="Clube — upsell WhatsApp" />
            </Field>
            <Field label="Endereço" hint={`/oferta/${f.slug || '…'}`}>
              <Input value={f.slug} onChange={(e) => (setSlugTouched(true), set({ slug: slugify(e.target.value) }))} placeholder="clube" />
            </Field>
          </div>
          <Field label="Título grande"><Input value={f.headline} onChange={(e) => set({ headline: e.target.value })} placeholder="Atividades prontas toda semana para a sua turma" maxLength={200} /></Field>
          <Field label="Subtítulo (opcional)"><Textarea rows={2} value={f.subheadline ?? ''} onChange={(e) => set({ subheadline: e.target.value })} maxLength={400} /></Field>

          <VideoUpload value={f} onChange={(v) => set(v)} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Texto do botão"><Input value={f.cta_text} onChange={(e) => set({ cta_text: e.target.value })} maxLength={60} /></Field>
            <Field label="Mostrar o botão após (s de vídeo)" hint="0 = o botão aparece na hora">
              <Input type="number" min={0} max={3600} value={f.button_delay_seconds} onChange={(e) => set({ button_delay_seconds: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
            </Field>
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium text-gray-700">Benefícios (até 4, opcionais)</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {bullets.map((b, i) => (
                <Input key={i} value={b} maxLength={120} placeholder={['Atividades novas toda semana', 'Pronto para imprimir', 'Cancele quando quiser', 'Acesso imediato'][i]} onChange={(e) => {
                  const next = [...bullets];
                  next[i] = e.target.value;
                  set({ bullets: next.map((x) => x.trim()).filter(Boolean) });
                }} />
              ))}
            </div>
          </div>
          <Field label="Garantia (opcional)"><Input value={f.guarantee ?? ''} onChange={(e) => set({ guarantee: e.target.value })} maxLength={200} placeholder="7 dias de garantia: não gostou, devolvemos seu dinheiro." /></Field>
          <Switch checked={f.active} onChange={(v) => set({ active: v })} label={f.active ? 'Página no ar' : 'Página pausada'} />
          {err && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancelar</Button>
            <Button loading={save.isPending} onClick={() => (setErr(null), save.mutate())}>Salvar página</Button>
          </div>
        </div>
        <Preview f={f} />
      </div>
    </Modal>
  );
}

/** Prévia em formato de celular. */
function Preview({ f }: { f: Form }) {
  return (
    <div className="hidden lg:block">
      <p className="mb-2 text-xs font-medium text-zinc-500">Prévia (celular)</p>
      <div className="sticky top-4 overflow-hidden rounded-[28px] border-[6px] border-zinc-800 bg-[#0b0d12] px-3 pb-6 pt-5 text-center text-white">
        <p className="text-[15px] font-extrabold leading-tight">{f.headline || 'Título grande'}</p>
        {f.subheadline && <p className="mt-1.5 text-[11px] text-white/70">{f.subheadline}</p>}
        <div className="relative mt-3 aspect-video overflow-hidden rounded-xl bg-black">
          {f.poster_url ? <img src={f.poster_url} alt="" className="h-full w-full object-cover" /> : <Film className="absolute inset-0 m-auto h-6 w-6 text-zinc-600" />}
        </div>
        <div className="mt-3 rounded-xl bg-emerald-500 px-3 py-2.5 text-[12px] font-extrabold">{f.cta_text || 'Botão'}</div>
        {f.button_delay_seconds > 0 && <p className="mt-1 text-[10px] text-white/50">aparece após {f.button_delay_seconds}s de vídeo</p>}
        {f.bullets.length > 0 && (
          <ul className="mt-3 space-y-1 text-left">
            {f.bullets.map((b, i) => <li key={i} className="flex gap-1.5 rounded-lg bg-white/5 px-2 py-1.5 text-[10px]"><Check className="h-3 w-3 shrink-0 text-emerald-400" /> {b}</li>)}
          </ul>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ vídeo (comprime no navegador e sobe)
function VideoUpload({ value, onChange }: { value: Form; onChange: (v: Partial<Form>) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<{ step: string; p: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => {
    void import('@/lib/videoCompress').then((m) => m.canCompress()).then(setSupported).catch(() => setSupported(false));
  }, []);

  async function put(blob: Blob, name: string, type: string) {
    const path = `offers/${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}-${name}`;
    const { error } = await supabase.storage.from('media').upload(path, blob, { cacheControl: '31536000', upsert: false, contentType: type });
    if (error) throw new Error(/exceed|too large|size/i.test(error.message) ? 'O arquivo passou do limite de tamanho do armazenamento. Use um vídeo mais curto.' : error.message);
    return supabase.storage.from('media').getPublicUrl(path).data.publicUrl;
  }

  async function handle(file: File) {
    setErr(null);
    setInfo(null);
    if (!/^video\//.test(file.type) && !/\.(mp4|mov|m4v|webm)$/i.test(file.name)) return setErr('Envie um vídeo (MP4, MOV…)');
    try {
      const started = Date.now();
      if (supported) {
        const { compressVideo } = await import('@/lib/videoCompress');
        const r = await compressVideo(file, (step, p) => setState({ step: step === 'hd' ? 'Comprimindo em 720p' : step === 'sd' ? 'Criando versão leve (480p)' : 'Gerando a capa', p }));
        setState({ step: 'Enviando o vídeo', p: 0 });
        const hd = await put(r.hd, 'hd.mp4', 'video/mp4');
        setState({ step: 'Enviando o vídeo', p: 0.6 });
        const sd = r.sd ? await put(r.sd, 'sd.mp4', 'video/mp4') : null;
        const poster = r.poster ? await put(r.poster, 'poster.jpg', 'image/jpeg') : null;
        onChange({ video_url: hd, video_sd_url: sd, poster_url: poster ?? value.poster_url });
        const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
        setInfo(`Pronto em ${Math.round((Date.now() - started) / 1000)}s: ${mb(file.size)} → ${mb(r.hd.size)} (720p)${r.sd ? ` + ${mb(r.sd.size)} (480p)` : ''}.`);
      } else {
        // navegador sem conversor de vídeo: sobe o original (só MP4 e até 45 MB)
        if (!/mp4$/i.test(file.type) && !/\.mp4$/i.test(file.name)) throw new Error('Este navegador não comprime vídeo. Use o Chrome no computador, ou envie um MP4 já pronto.');
        if (file.size > 45 * 1024 * 1024) throw new Error('Este navegador não comprime vídeo e o arquivo passa de 45 MB. Use o Chrome no computador.');
        setState({ step: 'Enviando o vídeo (sem compressão)', p: 0.3 });
        onChange({ video_url: await put(file, 'video.mp4', 'video/mp4'), video_sd_url: null });
        setInfo('Vídeo enviado sem compressão (navegador sem suporte). Para ficar mais leve, envie de novo pelo Chrome no computador.');
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Não foi possível processar o vídeo');
    } finally {
      setState(null);
      if (ref.current) ref.current.value = '';
    }
  }

  return (
    <div className="rounded-xl border border-zinc-200 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Film className="h-5 w-5 text-zinc-500" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-zinc-800">Vídeo da oferta (VSL)</p>
          <p className="text-xs text-zinc-500">MP4 do celular ou do computador. Comprimimos aqui mesmo (720p + versão leve 480p + capa) antes de subir.</p>
        </div>
        <input ref={ref} type="file" accept="video/*,.mp4,.mov,.m4v" className="hidden" onChange={(e) => e.target.files?.[0] && void handle(e.target.files[0])} />
        <Button type="button" variant="secondary" disabled={Boolean(state)} onClick={() => ref.current?.click()}>
          <Upload className="h-4 w-4" /> {value.video_url ? 'Trocar vídeo' : 'Enviar vídeo'}
        </Button>
      </div>
      {state && (
        <div className="mt-3">
          <p className="mb-1 text-xs font-medium text-zinc-600">{state.step}… {state.p > 0 && state.p < 1 ? `${Math.round(state.p * 100)}%` : ''}</p>
          <div className="h-2 overflow-hidden rounded-full bg-zinc-100"><div className={cn('h-full rounded-full bg-blue-600 transition-all', state.p === 0 && 'w-1/3 animate-pulse')} style={state.p > 0 ? { width: `${Math.round(state.p * 100)}%` } : undefined} /></div>
          <p className="mt-1 text-[11px] text-zinc-500">Não feche esta janela até terminar.</p>
        </div>
      )}
      {supported === false && !state && <p className="mt-2 text-xs text-amber-600">Este navegador não comprime vídeo. Para o vídeo ficar leve, use o Chrome no computador.</p>}
      {info && <p className="mt-2 text-xs font-medium text-emerald-700">{info}</p>}
      {err && <p className="mt-2 text-xs font-medium text-red-600">{err}</p>}
      {value.video_url && !state && (
        <video src={value.video_url} poster={value.poster_url ?? undefined} controls preload="none" playsInline className="mt-3 aspect-video w-full rounded-lg bg-black" />
      )}
    </div>
  );
}
