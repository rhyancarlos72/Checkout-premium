import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, BarChart3, CheckCircle2, Clock, FileUp, ListChecks, Megaphone, Mic, RotateCcw, Send, Trash2, Upload, Users, UserX } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Badge, Button, Card, cn, EmptyState, Field, Input, PageLoader, Select, Switch, Textarea, useToast } from '@/components/ui';
import { adminApi, ApiError } from '@/lib/api';
import { previewContacts, type CsvPreview } from '@/lib/csv';
import { brl, dateTime } from '@/lib/format';
import { supabase } from '@/lib/supabase';
import { PageHeader } from './AdminApp';

/**
 * Áudios no WhatsApp (pela Evolution), em abas:
 *  Visão geral · Áudios · Recuperação · Upsell · Contatos importados · Fila e SAIR.
 * A configuração é uma só: alterou qualquer aba, aparece a barra "Salvar alterações" embaixo.
 */
type Kind = 'recovery' | 'upsell';
interface Audio {
  id: string;
  kind: Kind;
  name: string;
  file_url: string;
  active: boolean;
  created_at: string;
  sent: number;
  clicks: number;
  clickers: number;
  orders: number;
  paid: number;
  revenue_cents: number;
  conversion: number;
}
interface Config {
  enabled: boolean;
  windowStart: number;
  windowEnd: number;
  recovery: { enabled: boolean; product_ids: string[]; linkText: string; attempts: number[]; opener: string; openerLast: string; audioFirst: string; audioLast: string; gapSeconds: number };
  upsell: { enabled: boolean; checkout_slug: string; page_slug: string; audio: string; product_ids: string[]; delayMinutes: number; validityHours: number; gapSeconds: number; opener: string; linkText: string };
  backfill: { enabled: boolean; daysBack: number; intervalMinutes: number; perInterval: number };
  upsell2: { enabled: boolean; delayHours: number; firstMonthCents: number; validityHours: number; audio: string; opener: string; linkText: string };
  contacts: { enabled: boolean; opener: string };
  safety: { replyGate: boolean; recoveryGateFirst: boolean; waitHours: number; dailyCapPerNumber: number };
}
interface QueueRow { id: string; kind: Kind; attempt?: number | null; contact_id?: string | null; step: number; status: string; phone: string; run_at: string; error: string | null; created_at: string }
interface Data {
  ready: boolean;
  sql_hint: string | null;
  config: Config;
  webhook_url: string;
  audios: Audio[];
  queue: QueueRow[];
  optouts: { phone: string; word: string | null; created_at: string }[];
  checkouts: { slug: string; name: string }[];
  products: { id: string; name: string; active: boolean }[];
  pages: { slug: string; title: string; active: boolean }[];
  backfill: { sent: number; last_at: string | null; remaining: number; next_at: string | null } | null;
  attempt_ready?: boolean;
  cold_today?: { instance: string; used: number }[];
  paused?: { paused_reason?: string; paused_at?: string } | null;
}
interface ListInfo { name: string; total: number; pending: number; queued: number; sent: number; skipped: number }
interface Contacts {
  ready: boolean;
  error?: string;
  total: number;
  pending: number;
  queued: number;
  sent: number;
  skipped: number;
  lists: ListInfo[];
  skip_reasons: { reason: string; count: number }[];
  paused: { paused_reason?: string; paused_at?: string } | null;
}

type Tab = 'geral' | 'audios' | 'recuperacao' | 'upsell' | 'contatos' | 'fila';
const TABS: { id: Tab; label: string; icon: typeof Mic }[] = [
  { id: 'geral', label: 'Visão geral', icon: BarChart3 },
  { id: 'audios', label: 'Áudios', icon: Mic },
  { id: 'recuperacao', label: 'Recuperação', icon: RotateCcw },
  { id: 'upsell', label: 'Upsell', icon: Megaphone },
  { id: 'contatos', label: 'Contatos importados', icon: Users },
  { id: 'fila', label: 'Fila e SAIR', icon: ListChecks },
];

/** Em qual etapa cada áudio está sendo usado (pela configuração salva). */
function usage(cfg: Config, a: { id: string; kind: Kind }) {
  const out: string[] = [];
  if (a.kind === 'upsell') {
    if (cfg.upsell.audio === a.id) out.push('Upsell (apresentação)');
    if (cfg.upsell2?.audio === a.id) out.push('Última chamada');
  } else {
    if (cfg.recovery.audioFirst === a.id) out.push('1º lembrete');
    if (cfg.recovery.audioLast === a.id) out.push('Último lembrete');
  }
  return out.length ? out : ['Revezamento'];
}
const kindLabel: Record<Kind, string> = { recovery: 'Recuperação', upsell: 'Upsell' };
const queueText: Record<string, string> = { pending: 'Na fila', sending: 'Enviando', done: 'Enviado', skipped: 'Pulado', failed: 'Falhou', canceled: 'Cancelado' };
const queueTone: Record<string, string> = { pending: 'pending', sending: 'info', done: 'paid', skipped: 'off', failed: 'failed', canceled: 'canceled' };
const stepText = (r: QueueRow) =>
  r.kind === 'upsell' ? (['Texto de abertura', 'Áudio', 'Link'][r.step] ?? '') : (['Texto de abertura', 'Áudio', 'Link + Pix'][r.step] ?? '');
const phoneFmt = (p: string) => p.replace(/^55(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3');
const num = (v: string) => Math.max(0, Math.floor(Number(v) || 0));
const perDay = (c: Config) => Math.floor(((c.windowEnd - c.windowStart) * 60 * Math.max(1, c.backfill.perInterval)) / Math.max(10, c.backfill.intervalMinutes));

function readTab(): Tab {
  const h = window.location.hash.replace('#', '') as Tab;
  return TABS.some((t) => t.id === h) ? h : 'geral';
}

export default function AudiosPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error } = useQuery({ queryKey: ['wa-audio'], queryFn: () => adminApi.get<Data>('/whatsapp/audio') });
  const contacts = useQuery({ queryKey: ['wa-contacts'], queryFn: () => adminApi.get<Contacts>('/whatsapp/contacts'), retry: false });
  const refresh = () => (qc.invalidateQueries({ queryKey: ['wa-audio'] }), qc.invalidateQueries({ queryKey: ['wa-contacts'] }));
  const fail = (e: unknown) => toast.err(e instanceof ApiError ? e.message : 'Erro');
  const [tab, setTabState] = useState<Tab>(readTab);
  const setTab = (t: Tab) => {
    setTabState(t);
    window.history.replaceState(null, '', `#${t}`);
  };
  // configuração única, compartilhada pelas abas
  const [c, setC] = useState<Config | null>(null);
  useEffect(() => {
    if (data?.config) setC(data.config);
  }, [data?.config]);
  const dirty = useMemo(() => Boolean(c && data && JSON.stringify(c) !== JSON.stringify(data.config)), [c, data]);
  const save = useMutation({
    mutationFn: () => adminApi.put('/whatsapp/audio/config', c),
    onSuccess: () => (toast.ok('Configuração salva'), refresh()),
    onError: fail,
  });

  if (isLoading || (data && !c)) return <PageLoader />;
  if (error || !data || !c) return <Card><p className="text-sm text-red-600">{error instanceof ApiError ? error.message : 'Não foi possível carregar.'}</p></Card>;
  const props = { data, c, setC: (x: Config) => setC(x), fail, refresh };

  return (
    <>
      {toast.node}
      <PageHeader title="Áudios no WhatsApp" subtitle="Recuperação e upsell por áudio (texto → áudio → link), tudo pela Evolution, no horário que você escolher." />
      {!data.ready && <Alert tone="warn">{data.sql_hint}</Alert>}
      {data.ready && data.attempt_ready === false && <Alert tone="warn">Rode no Supabase o SQL da recuperação em mais de um lembrete (supabase/migrations/20261122000000_wa_queue_attempt.sql). Até lá, a recuperação segue em texto.</Alert>}

      <nav className="-mx-4 mb-5 overflow-x-auto px-4 sm:mx-0 sm:px-0" aria-label="Seções">
        <div className="inline-flex min-w-full gap-1 rounded-2xl border border-zinc-200 bg-white p-1 sm:min-w-0">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn('flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium transition', tab === t.id ? 'bg-blue-600 text-white shadow-sm' : 'text-zinc-600 hover:bg-zinc-100')}
              aria-current={tab === t.id ? 'page' : undefined}
            >
              <t.icon className="h-4 w-4" /> {t.label}
            </button>
          ))}
        </div>
      </nav>

      {tab === 'geral' && <OverviewTab {...props} contacts={contacts.data ?? null} go={setTab} />}
      {tab === 'audios' && <AudioList data={data} onChange={refresh} fail={fail} />}
      {tab === 'recuperacao' && <RecoveryTab {...props} />}
      {tab === 'upsell' && <UpsellTab {...props} />}
      {tab === 'contatos' && <ContactsTab {...props} contacts={contacts.data ?? null} contactsError={contacts.error} />}
      {tab === 'fila' && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
          <div className="min-w-0"><QueueCard rows={data.queue} /></div>
          <div className="min-w-0"><OptOutCard data={data} onChange={refresh} fail={fail} /></div>
        </div>
      )}

      {dirty && (
        <div className="sticky bottom-4 z-30 mt-6">
          <div className="mx-auto flex max-w-2xl flex-col items-center gap-3 rounded-2xl border border-zinc-200 bg-white p-3 shadow-[0_12px_40px_-12px_rgba(0,0,0,.35)] sm:flex-row sm:pl-5">
            <p className="flex-1 text-sm font-medium text-zinc-700">Você tem alterações não salvas.</p>
            <div className="flex w-full gap-2 sm:w-auto">
              <Button type="button" variant="ghost" className="flex-1 sm:flex-none" onClick={() => setC(data.config)}>Descartar</Button>
              <Button type="button" className="flex-1 sm:flex-none" loading={save.isPending} onClick={() => save.mutate()}>Salvar alterações</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

type TabProps = { data: Data; c: Config; setC: (c: Config) => void; fail: (e: unknown) => void; refresh: () => void };

// ------------------------------------------------------------------ peças de layout
function Alert({ tone, children }: { tone: 'warn' | 'ok' | 'info'; children: ReactNode }) {
  const cls = tone === 'warn' ? 'border-amber-300 bg-amber-50 text-amber-800' : tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-blue-200 bg-blue-50 text-blue-800';
  const Icon = tone === 'warn' ? AlertTriangle : tone === 'ok' ? CheckCircle2 : Clock;
  return (
    <div className={cn('mb-4 flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm font-medium', cls)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" /> <div className="min-w-0">{children}</div>
    </div>
  );
}
/** Cartão de uma etapa: título, explicação curta e o liga/desliga no topo. */
function Section({ title, desc, on, onToggle, children, aside }: { title: string; desc?: ReactNode; on?: boolean; onToggle?: (v: boolean) => void; children?: ReactNode; aside?: ReactNode }) {
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold text-zinc-900">{title}</h3>
          {desc && <p className="mt-1 text-sm text-zinc-500">{desc}</p>}
        </div>
        {onToggle && <Switch checked={Boolean(on)} onChange={onToggle} label={on ? 'Ligado' : 'Desligado'} />}
        {aside}
      </div>
      {children && <div className={cn('mt-5 space-y-4', onToggle && !on && 'opacity-60')}>{children}</div>}
    </Card>
  );
}
const Stat = ({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) => (
  <div className="rounded-xl bg-zinc-50 px-3 py-2.5">
    <p className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{label}</p>
    <p className="mt-0.5 text-lg font-semibold tabular-nums text-zinc-900">{value}</p>
    {hint && <p className="text-[11px] text-zinc-500">{hint}</p>}
  </div>
);
function AudioSelect({ data, kind, value, onChange, empty }: { data: Data; kind: Kind; value: string; onChange: (v: string) => void; empty: string }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{empty}</option>
      {data.audios.filter((a) => a.kind === kind).map((a) => <option key={a.id} value={a.id}>{a.name}{a.active ? '' : ' (pausado)'}</option>)}
    </Select>
  );
}

// ------------------------------------------------------------------ visão geral
function OverviewTab({ data, c, setC, contacts, go }: TabProps & { contacts: Contacts | null; go: (t: Tab) => void }) {
  const t = data.audios.reduce((s, a) => ({ sent: s.sent + a.sent, clicks: s.clicks + a.clicks, paid: s.paid + a.paid, revenue: s.revenue + a.revenue_cents }), { sent: 0, clicks: 0, paid: 0, revenue: 0 });
  const upAudios = data.audios.filter((a) => a.kind === 'upsell').length;
  const recAudios = data.audios.filter((a) => a.kind === 'recovery').length;
  const warnings: { text: string; tab: Tab }[] = [];
  if (c.upsell.enabled && !data.audios.some((a) => a.kind === 'upsell' && a.active)) warnings.push({ text: 'O upsell está ligado, mas não há áudio de upsell ativo.', tab: 'audios' });
  if (c.upsell2.enabled && !c.upsell.page_slug) warnings.push({ text: 'A última chamada precisa da página de vendas escolhida no Upsell.', tab: 'upsell' });
  if (upAudios > 1 && (!c.upsell.audio || (c.upsell2.enabled && !c.upsell2.audio))) warnings.push({ text: 'Escolha o áudio da apresentação e o da última chamada (para nunca ir o áudio de uma etapa na outra).', tab: 'upsell' });
  if (recAudios > 1 && (!c.recovery.audioFirst || !c.recovery.audioLast)) warnings.push({ text: 'Escolha o áudio do 1º e do último lembrete da recuperação.', tab: 'recuperacao' });
  const pause = data.paused ?? contacts?.paused;
  if (pause?.paused_reason && !c.backfill.enabled && !c.contacts.enabled) warnings.push({ text: `Envios para quem já comprou pausados sozinhos para proteger os números: ${pause.paused_reason}.`, tab: 'upsell' });
  const flows: { label: string; on: boolean; detail: string; tab: Tab }[] = [
    { label: 'Recuperação por áudio', on: c.recovery.enabled, detail: `${c.recovery.attempts.map((n) => `${n}º`).join(' e ') || 'nenhum'} lembrete(s)`, tab: 'recuperacao' },
    { label: 'Upsell (apresentação)', on: c.upsell.enabled, detail: `${Math.round(c.upsell.delayMinutes / 60 * 10) / 10} h depois da compra`, tab: 'upsell' },
    { label: 'Última chamada', on: c.upsell2.enabled, detail: `${c.upsell2.delayHours} h depois · 1º mês ${brl(c.upsell2.firstMonthCents)}`, tab: 'upsell' },
    { label: 'Compradores antigos', on: c.backfill.enabled, detail: `${data.backfill?.remaining ?? 0} faltam`, tab: 'upsell' },
    { label: 'Contatos importados', on: c.contacts.enabled, detail: `${contacts?.pending ?? 0} na espera`, tab: 'contatos' },
  ];
  return (
    <div className="space-y-4">
      {warnings.map((w) => (
        <Alert key={w.text} tone="warn">
          {w.text} <button type="button" className="ml-1 underline underline-offset-2" onClick={() => go(w.tab)}>Resolver</button>
        </Alert>
      ))}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Sequências enviadas" value={t.sent} />
        <Stat label="Cliques nos links" value={t.clicks} />
        <Stat label="Vendas pagas" value={t.paid} />
        <Stat label="Faturamento" value={<span className="pv">{brl(t.revenue)}</span>} />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Card title="O que está ligado">
          <ul className="divide-y divide-zinc-100">
            {flows.map((f) => (
              <li key={f.label} className="flex items-center gap-3 py-2.5">
                <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', f.on ? 'bg-emerald-500' : 'bg-zinc-300')} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-zinc-900">{f.label}</span>
                  <span className="block text-xs text-zinc-500">{f.on ? f.detail : 'Desligado'}</span>
                </span>
                <button type="button" className="text-xs font-semibold text-blue-600 hover:underline" onClick={() => go(f.tab)}>Ajustar</button>
              </li>
            ))}
          </ul>
        </Card>
        <div className="min-w-0 space-y-4">
        <Section title="Geral" desc="Vale para todos os envios por áudio.">
          <Switch checked={c.enabled} onChange={(v) => setC({ ...c, enabled: v })} label={c.enabled ? 'Áudios ligados' : 'Áudios desligados'} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Enviar a partir de (h)"><Input type="number" min={0} max={23} value={c.windowStart} onChange={(e) => setC({ ...c, windowStart: num(e.target.value) })} /></Field>
            <Field label="Até (h)"><Input type="number" min={1} max={24} value={c.windowEnd} onChange={(e) => setC({ ...c, windowEnd: num(e.target.value) })} /></Field>
          </div>
          <p className="text-xs text-zinc-500">Horário de Brasília. Fora dele, os envios esperam a próxima abertura (a recuperação vai em texto na hora).</p>
        </Section>
        <Safety data={data} c={c} setC={setC} />
        </div>
      </div>
    </div>
  );
}

/**
 * Proteção dos números (anti-bloqueio): pergunta primeiro e só segue se a pessoa responder, limite de conversas
 * novas por número por dia e o uso de hoje de cada número.
 */
function Safety({ data, c, setC }: { data: Data; c: Config; setC: (c: Config) => void }) {
  const sf = (p: Partial<Config['safety']>) => setC({ ...c, safety: { ...c.safety, ...p } });
  const used = new Map((data.cold_today ?? []).map((x) => [x.instance, x.used]));
  const wa = useQuery({ queryKey: ['whatsapp-config'], queryFn: () => adminApi.get<{ instances: { name: string; active: boolean }[] }>('/whatsapp') });
  const names = (wa.data?.instances ?? []).filter((i) => i.active).map((i) => i.name);
  return (
    <Section title="Proteção dos números" desc="Evita bloqueio: mensagens sem resposta e muitas conversas novas no mesmo número são o que o WhatsApp lê como spam.">
      <Switch checked={c.safety.replyGate} onChange={(v) => sf({ replyGate: v })} label="Upsell: pergunta primeiro, áudio e link só se a pessoa responder" />
      <Switch checked={c.safety.recoveryGateFirst} onChange={(v) => sf({ recoveryGateFirst: v })} label="Recuperação: o 1º lembrete com áudio também pergunta primeiro" />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Esperar resposta por (h)" hint="Sem resposta: para"><Input type="number" min={1} max={72} value={c.safety.waitHours} onChange={(e) => sf({ waitHours: Math.max(1, num(e.target.value)) })} /></Field>
        <Field label="Conversas novas por número/dia" hint="Aquecendo: 15 · depois: 30"><Input type="number" min={1} max={500} value={c.safety.dailyCapPerNumber} onChange={(e) => sf({ dailyCapPerNumber: Math.max(1, num(e.target.value)) })} /></Field>
      </div>
      {names.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-semibold text-zinc-700">Conversas de upsell iniciadas hoje</p>
          <ul className="space-y-1.5">
            {names.map((n) => {
              const u = used.get(n) ?? 0;
              const pct = Math.min(100, Math.round((u / Math.max(1, c.safety.dailyCapPerNumber)) * 100));
              return (
                <li key={n} className="text-xs">
                  <div className="flex justify-between text-zinc-600"><span>{n}</span><span className="tabular-nums">{u} / {c.safety.dailyCapPerNumber}</span></div>
                  <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-zinc-100"><div className={cn('h-full rounded-full', pct >= 100 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${pct}%` }} /></div>
                </li>
              );
            })}
          </ul>
          <p className="mt-1.5 text-[11px] text-zinc-500">Bateu o limite, as próximas ficam para amanhã. Recuperação e mensagens de entrega não contam.</p>
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ áudios + relatório
function AudioList({ data, onChange, fail }: { data: Data; onChange: () => void; fail: (e: unknown) => void }) {
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<Kind>('recovery');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [testPhone, setTestPhone] = useState('');

  async function upload(file: File) {
    if (!name.trim() || name.trim().length < 2) return toast.err('Dê um nome ao áudio antes de enviar (ex.: "Convite Clube v1")');
    if (!/^audio\//.test(file.type) && !/\.(mp3|ogg|opus|m4a|aac|wav)$/i.test(file.name)) return toast.err('Envie um arquivo de áudio (mp3, ogg, m4a…)');
    if (file.size > 16 * 1024 * 1024) return toast.err('Áudio acima de 16 MB');
    setBusy(true);
    try {
      const ext = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp3';
      // nome aleatório: ninguém adivinha o endereço do arquivo
      const path = `wa-audio/${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage.from('media').upload(path, file, { cacheControl: '31536000', upsert: false, contentType: file.type || 'audio/mpeg' });
      if (error) throw new ApiError(400, error.message);
      const url = supabase.storage.from('media').getPublicUrl(path).data.publicUrl;
      await adminApi.post('/whatsapp/audio/files', { kind, name: name.trim(), file_url: url });
      toast.ok('Áudio adicionado');
      setName('');
      onChange();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = '';
    }
  }

  const toggle = useMutation({ mutationFn: (a: Audio) => adminApi.put(`/whatsapp/audio/files/${a.id}`, { active: !a.active }), onSuccess: onChange, onError: fail });
  const remove = useMutation({ mutationFn: (a: Audio) => adminApi.del(`/whatsapp/audio/files/${a.id}`), onSuccess: () => (toast.ok('Áudio apagado'), onChange()), onError: fail });
  const test = useMutation({
    mutationFn: (a: Audio) => adminApi.post<{ ok: boolean; message: string; hint?: string }>(`/whatsapp/audio/files/${a.id}/test`, { phone: testPhone }),
    onSuccess: (r) => (r.ok ? toast.ok(r.message) : toast.err(`${r.message}${r.hint ? ` — ${r.hint}` : ''}`)),
    onError: fail,
  });

  const groups: Kind[] = ['recovery', 'upsell'];
  return (
    <div className="space-y-4">
      {toast.node}
      <Section title="Enviar um áudio" desc="Grave no celular (mp3, ogg ou m4a, até 16 MB). Depois escolha em qual etapa ele vai, nas abas Recuperação e Upsell.">
        <div className="grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)_auto] sm:items-end">
          <Field label="Tipo">
            <Select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              <option value="recovery">Recuperação</option>
              <option value="upsell">Upsell</option>
            </Select>
          </Field>
          <Field label="Nome do áudio"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Convite Clube v1" maxLength={80} /></Field>
          <div>
            <input ref={ref} type="file" accept="audio/*,.mp3,.ogg,.opus,.m4a" className="hidden" onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
            <Button type="button" className="w-full sm:w-auto" loading={busy} disabled={!data.ready} onClick={() => ref.current?.click()}>
              <Upload className="h-4 w-4" /> Enviar áudio
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input value={testPhone} onChange={(e) => setTestPhone(e.target.value)} placeholder="Seu WhatsApp para testar (DDD + número)" className="sm:max-w-xs" />
          <span className="text-xs text-zinc-500">Use o botão “Testar” de um áudio para recebê-lo neste número.</span>
        </div>
      </Section>

      {groups.map((g) => {
        const list = data.audios.filter((a) => a.kind === g);
        return (
          <Card key={g} title={`${kindLabel[g]} (${list.length})`}>
            {!list.length ? (
              <p className="rounded-xl border border-dashed border-zinc-200 px-4 py-5 text-center text-sm text-zinc-500">
                {g === 'recovery' ? 'Sem áudio: os lembretes continuam indo em texto.' : 'Sem áudio: o upsell não é enviado.'}
              </p>
            ) : (
              <div className="grid gap-3 lg:grid-cols-2">
                {list.map((a) => (
                  <div key={a.id} className={cn('rounded-xl border p-3', a.active ? 'border-zinc-200' : 'border-zinc-200 bg-zinc-50 opacity-70')}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Mic className="h-4 w-4 text-zinc-500" />
                      <span className="min-w-0 flex-1 truncate font-medium">{a.name}</span>
                      <Switch checked={a.active} onChange={() => toggle.mutate(a)} label={a.active ? 'Ativo' : 'Pausado'} />
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {usage(data.config, a).map((u) => (
                        <span key={u} className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', u === 'Revezamento' ? 'bg-zinc-100 text-zinc-600' : 'bg-blue-50 text-blue-700')}>{u}</span>
                      ))}
                    </div>
                    <audio controls preload="none" src={a.file_url} className="mt-2 h-9 w-full" />
                    <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                      <MiniStat label="Enviados" value={a.sent} />
                      <MiniStat label="Cliques" value={a.clicks} />
                      <MiniStat label="Pagos" value={a.paid} />
                      <MiniStat label="Pedidos" value={a.orders} />
                      <MiniStat label="Faturamento" value={<span className="pv">{brl(a.revenue_cents)}</span>} />
                      <MiniStat label="Conversão" value={`${a.conversion.toLocaleString('pt-BR')}%`} />
                    </div>
                    <div className="mt-3 flex flex-wrap justify-end gap-2">
                      <Button type="button" variant="secondary" size="sm" disabled={testPhone.replace(/\D/g, '').length < 10} loading={test.isPending && test.variables?.id === a.id} onClick={() => test.mutate(a)}>
                        <Send className="h-3.5 w-3.5" /> Testar
                      </Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => confirm(`Apagar o áudio "${a.name}"? O relatório dele some junto.`) && remove.mutate(a)}>
                        <Trash2 className="h-3.5 w-3.5" /> Apagar
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
const MiniStat = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className="rounded-lg bg-zinc-50 px-2 py-1.5">
    <p className="text-[11px] text-zinc-500">{label}</p>
    <p className="text-sm font-semibold tabular-nums">{value}</p>
  </div>
);

// ------------------------------------------------------------------ recuperação
function RecoveryTab({ data, c, setC }: TabProps) {
  const r = c.recovery;
  const set = (p: Partial<Config['recovery']>) => setC({ ...c, recovery: { ...r, ...p } });
  return (
    <div className="space-y-4">
      <Section
        title="Recuperação por áudio"
        desc="Pix gerado e não pago: nos lembretes marcados vai a sequência texto curto → áudio → link + Pix. Os outros lembretes seguem em texto. Fora do horário, o lembrete vai em texto na hora."
        on={r.enabled}
        onToggle={(v) => set({ enabled: v })}
      >
        <div>
          <p className="mb-1.5 text-sm font-medium text-gray-700">Lembretes com áudio</p>
          <div className="flex flex-wrap gap-2">
            {[1, 2, 3].map((n) => {
              const on = r.attempts.includes(n);
              return (
                <label key={n} className={cn('flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm transition', on ? 'border-blue-600 bg-blue-600 text-white' : 'border-zinc-200 text-zinc-600 hover:border-zinc-300')}>
                  <input type="checkbox" className="h-4 w-4 accent-white" checked={on} onChange={() => set({ attempts: on ? r.attempts.filter((x) => x !== n) : [...r.attempts, n].sort() })} />
                  {n}º lembrete{n === 3 ? ' (último)' : ''}
                </label>
              );
            })}
          </div>
        </div>
        <ProductPicker
          label="Produtos com recuperação por áudio"
          hint="Pix pendente de um destes produtos recebe os lembretes marcados com áudio. Os outros seguem em texto."
          empty="Nenhum marcado: todos os lembretes seguem em texto."
          products={data.products}
          value={r.product_ids}
          onChange={(ids) => set({ product_ids: ids })}
        />
      </Section>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Section title="1º lembrete" desc="A primeira mensagem e o áudio do 1º lembrete.">
          <Field label="1ª mensagem" hint="Use {nome} e {produto}."><Textarea rows={3} value={r.opener} onChange={(e) => set({ opener: e.target.value })} /></Field>
          <Field label="Áudio" hint="Usado sempre. Pausado: o lembrete vai em texto (nunca troca por outro áudio).">
            <AudioSelect data={data} kind="recovery" value={r.audioFirst} onChange={(v) => set({ audioFirst: v })} empty="Revezar (só os não escolhidos em outra etapa)" />
          </Field>
        </Section>
        <Section title="Último lembrete" desc="A primeira mensagem e o áudio do último lembrete com áudio.">
          <Field label="1ª mensagem" hint="Use {nome} e {produto}."><Textarea rows={3} value={r.openerLast} onChange={(e) => set({ openerLast: e.target.value })} /></Field>
          <Field label="Áudio" hint="Ex.: um áudio de “última chance”.">
            <AudioSelect data={data} kind="recovery" value={r.audioLast} onChange={(v) => set({ audioLast: v })} empty="Revezar (só os não escolhidos em outra etapa)" />
          </Field>
        </Section>
      </div>
      <Section title="Depois do áudio" desc="A mensagem com o link e o Pix copia e cola (numa mensagem separada).">
        <Field label="Mensagem com o link" hint="Use {nome}, {produto}, {valor}, {link} e {pix} (aviso do Pix copia e cola, só quando o Pix ainda vale).">
          <Textarea rows={4} value={r.linkText} onChange={(e) => set({ linkText: e.target.value })} />
        </Field>
        <Field label="Áudio sai após (s)" hint="Tempo entre a 1ª mensagem e o áudio" className="max-w-[220px]"><Input type="number" min={10} value={r.gapSeconds} onChange={(e) => set({ gapSeconds: num(e.target.value) })} /></Field>
      </Section>
    </div>
  );
}

// ------------------------------------------------------------------ upsell
function UpsellTab({ data, c, setC }: TabProps) {
  const u = c.upsell;
  const up = (p: Partial<Config['upsell']>) => setC({ ...c, upsell: { ...u, ...p } });
  const u2 = (p: Partial<Config['upsell2']>) => setC({ ...c, upsell2: { ...c.upsell2, ...p } });
  const bf = (p: Partial<Config['backfill']>) => setC({ ...c, backfill: { ...c.backfill, ...p } });
  return (
    <div className="space-y-4">
      <Section title="Upsell (apresentação)" desc={`Depois de uma compra paga: texto curto → áudio → link da oferta. No máximo 1 upsell a cada 7 dias por pessoa.`} on={u.enabled} onToggle={(v) => up({ enabled: v })}>
        <ProductPicker
          label="Quem comprou (produtos pagos)"
          hint="Recebe o upsell quem PAGOU um destes produtos (produto principal ou order bump)."
          empty="Nenhum marcado: o upsell não é enviado."
          products={data.products}
          value={u.product_ids}
          onChange={(ids) => up({ product_ids: ids })}
        />
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Áudio da apresentação" hint="Usado sempre. Pausado: o upsell não é enviado.">
            <AudioSelect data={data} kind="upsell" value={u.audio} onChange={(v) => up({ audio: v })} empty="Revezar (só os não escolhidos para a última chamada)" />
          </Field>
          <Field label="Página de vendas (link do áudio)" hint="Sem página: o link leva ao checkout abaixo.">
            <Select value={u.page_slug} onChange={(e) => up({ page_slug: e.target.value })}>
              <option value="">Nenhuma (usar o checkout)</option>
              {data.pages.map((p) => <option key={p.slug} value={p.slug}>{p.title} (/oferta/{p.slug}){p.active ? '' : ' · pausada'}</option>)}
            </Select>
          </Field>
          {!u.page_slug && (
            <Field label="Checkout oferecido" hint="Quem já comprou ou assina não recebe.">
              <Select value={u.checkout_slug} onChange={(e) => up({ checkout_slug: e.target.value })}>
                <option value="">Escolha…</option>
                {data.checkouts.map((k) => <option key={k.slug} value={k.slug}>{k.name} ({k.slug})</option>)}
              </Select>
            </Field>
          )}
        </div>
        <div className="grid grid-cols-3 gap-3 md:max-w-xl">
          <Field label="Enviar após (min)"><Input type="number" min={10} value={u.delayMinutes} onChange={(e) => up({ delayMinutes: num(e.target.value) })} /></Field>
          <Field label="Validade (h)"><Input type="number" min={1} value={u.validityHours} onChange={(e) => up({ validityHours: num(e.target.value) })} /></Field>
          <Field label="Áudio após (s)"><Input type="number" min={10} value={u.gapSeconds} onChange={(e) => up({ gapSeconds: num(e.target.value) })} /></Field>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="1ª mensagem"><Textarea rows={3} value={u.opener} onChange={(e) => up({ opener: e.target.value })} /></Field>
          <Field label="Mensagem depois do áudio (com o link)" hint="Use {nome}, {produto}, {link} e {validade}."><Textarea rows={5} value={u.linkText} onChange={(e) => up({ linkText: e.target.value })} /></Field>
        </div>
      </Section>

      <Section
        title="Última chamada (upsell 2)"
        desc={<>Para quem recebeu o upsell e não comprou: texto → áudio próprio → link com o <b>1º mês por um preço menor</b> (os meses seguintes no preço normal). O desconto só vale pelo link e só até a validade.</>}
        on={c.upsell2.enabled}
        onToggle={(v) => u2({ enabled: v })}
      >
        {c.upsell2.enabled && !u.page_slug && <p className="text-xs font-medium text-amber-600">Escolha a página de vendas no upsell acima: a última chamada só funciona com ela.</p>}
        <div className="grid grid-cols-3 gap-3 md:max-w-xl">
          <Field label="Enviar após (h)"><Input type="number" min={1} max={168} value={c.upsell2.delayHours} onChange={(e) => u2({ delayHours: num(e.target.value) })} /></Field>
          <Field label="1º mês por (R$)"><Input type="number" min={1} step={0.01} value={c.upsell2.firstMonthCents / 100} onChange={(e) => u2({ firstMonthCents: Math.max(100, Math.round(Number(e.target.value) * 100) || 100) })} /></Field>
          <Field label="Validade (h)"><Input type="number" min={1} max={168} value={c.upsell2.validityHours} onChange={(e) => u2({ validityHours: num(e.target.value) })} /></Field>
        </div>
        <Field label="Áudio da última chamada" hint="Usado sempre. Pausado: a última chamada não é enviada." className="md:max-w-md">
          <AudioSelect data={data} kind="upsell" value={c.upsell2.audio} onChange={(v) => u2({ audio: v })} empty="Revezar (só os não escolhidos para a apresentação)" />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="1ª mensagem" hint="Use {nome} e {produto}."><Textarea rows={3} value={c.upsell2.opener} onChange={(e) => u2({ opener: e.target.value })} /></Field>
          <Field label="Mensagem depois do áudio (com o link)" hint="Use {nome}, {produto}, {link}, {preco} (1º mês), {preco_normal} e {validade}."><Textarea rows={5} value={c.upsell2.linkText} onChange={(e) => u2({ linkText: e.target.value })} /></Field>
        </div>
      </Section>

      <Section
        title="Quem já comprou (compradores antigos daqui)"
        desc="Quem já comprou um dos produtos marcados no upsell recebe a mesma sequência, uma pessoa por vez, espaçado, no horário de envio. Mais recentes primeiro; cada pessoa recebe uma vez só."
        on={c.backfill.enabled}
        onToggle={(v) => bf({ enabled: v })}
      >
        <Rhythm c={c} setC={setC} />
        <Field label="Compras dos últimos (dias)" className="max-w-[220px]"><Input type="number" min={1} max={730} value={c.backfill.daysBack} onChange={(e) => bf({ daysBack: num(e.target.value) })} /></Field>
        {data.backfill && (
          <div className="grid grid-cols-3 gap-2 md:max-w-xl">
            <MiniStat label="Já enviados" value={data.backfill.sent} />
            <MiniStat label="Faltam (aprox.)" value={data.backfill.remaining} />
            <MiniStat label="Próximo" value={data.backfill.next_at ? new Date(data.backfill.next_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—'} />
          </div>
        )}
      </Section>
    </div>
  );
}

/** Ritmo dos envios para quem já comprou (vale para os compradores daqui e para os importados, na mesma vaga). */
function Rhythm({ c, setC }: { c: Config; setC: (c: Config) => void }) {
  const bf = (p: Partial<Config['backfill']>) => setC({ ...c, backfill: { ...c.backfill, ...p } });
  const gap = Math.round(c.backfill.intervalMinutes / Math.max(1, c.backfill.perInterval));
  return (
    <div className="rounded-xl bg-zinc-50 p-3">
      <p className="text-sm font-medium text-zinc-800">Ritmo (compradores daqui + contatos importados, juntos)</p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-zinc-700">
        <Input type="number" min={1} max={10} value={c.backfill.perInterval} onChange={(e) => bf({ perInterval: Math.min(10, Math.max(1, num(e.target.value))) })} className="!w-20" aria-label="Envios" />
        <span>envios a cada</span>
        <Input type="number" min={10} max={1440} value={c.backfill.intervalMinutes} onChange={(e) => bf({ intervalMinutes: Math.max(10, num(e.target.value)) })} className="!w-24" aria-label="Minutos" />
        <span>min</span>
      </div>
      <p className="mt-2 text-xs text-zinc-500">1 envio a cada ~{gap} min (nunca todos juntos), revezando os números · cerca de <b>{perDay(c)} por dia</b> no horário de envio. Primeiro os compradores daqui, depois os importados.</p>
    </div>
  );
}

// ------------------------------------------------------------------ contatos importados
function ContactsTab({ c, setC, fail, refresh, contacts, contactsError }: TabProps & { contacts: Contacts | null; contactsError: unknown }) {
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<(CsvPreview & { file: string }) | null>(null);
  const [listName, setListName] = useState('');
  const [progress, setProgress] = useState<{ done: number; total: number; inserted: number; existing: number } | null>(null);
  const remove = useMutation({ mutationFn: (name: string) => adminApi.del(`/whatsapp/contacts/lists/${encodeURIComponent(name)}`), onSuccess: () => (toast.ok('Lista apagada (quem já recebeu fica no histórico)'), refresh()), onError: fail });
  const notReady = contactsError instanceof ApiError ? contactsError.message : contacts && !contacts.ready ? 'Rode no Supabase o SQL dos contatos importados (supabase/migrations/20261123000000_wa_contacts.sql).' : null;

  async function pick(file: File) {
    if (file.size > 30 * 1024 * 1024) return toast.err('Arquivo acima de 30 MB');
    const p = previewContacts(await file.text());
    if (!p.columns.found.includes('WhatsApp')) return toast.err('Não achei a coluna do WhatsApp (telefone/celular/whatsapp) no arquivo.');
    setPreview({ ...p, file: file.name });
    setListName(file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 80));
  }
  async function doImport() {
    if (!preview) return;
    const rows = preview.rows;
    const size = 200;
    let inserted = 0;
    let existing = 0;
    setProgress({ done: 0, total: rows.length, inserted: 0, existing: 0 });
    try {
      for (let i = 0; i < rows.length; i += size) {
        const r = await adminApi.post<{ inserted: number; existing: number }>('/whatsapp/contacts/import', { list_name: listName.trim() || 'Importados', rows: rows.slice(i, i + size) });
        inserted += r.inserted;
        existing += r.existing;
        setProgress({ done: Math.min(rows.length, i + size), total: rows.length, inserted, existing });
      }
      toast.ok(`${inserted} contatos importados${existing ? ` (${existing} já estavam na lista)` : ''}`);
      setPreview(null);
      refresh();
    } catch (e) {
      fail(e);
    } finally {
      setProgress(null);
      if (ref.current) ref.current.value = '';
    }
  }
  const days = contacts?.pending ? Math.ceil(contacts.pending / Math.max(1, perDay(c))) : 0;

  return (
    <div className="space-y-4">
      {toast.node}
      {notReady && <Alert tone="warn">{notReady}</Alert>}
      {contacts?.paused?.paused_reason && !c.contacts.enabled && !c.backfill.enabled && (
        <Alert tone="warn">
          Pausado sozinho para proteger os números: {contacts.paused.paused_reason}. Confira a fila e os descadastros antes de religar.
        </Alert>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Contatos" value={contacts?.total ?? 0} />
        <Stat label="Na espera" value={contacts?.pending ?? 0} hint={days ? `~${days} dia(s) no ritmo atual` : undefined} />
        <Stat label="Já receberam" value={(contacts?.sent ?? 0) + (contacts?.queued ?? 0)} />
        <Stat label="Pulados" value={contacts?.skipped ?? 0} hint="assinantes, SAIR, já receberam…" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-w-0 space-y-4">
          <Section
            title="Importar contatos (CSV)"
            desc="Compradores do seu outro checkout. O arquivo é lido aqui no seu navegador e só os contatos válidos são enviados. Ficam separados das vendas: não mexem no faturamento nem no Pixel."
            aside={
              <>
                <input ref={ref} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && void pick(e.target.files[0])} />
                <Button type="button" disabled={Boolean(notReady) || Boolean(progress)} onClick={() => ref.current?.click()}><FileUp className="h-4 w-4" /> Escolher CSV</Button>
              </>
            }
          >
            {preview ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <MiniStat label="Válidos" value={preview.rows.length} />
                  <MiniStat label="WhatsApp inválido" value={preview.invalid} />
                  <MiniStat label="Repetidos no arquivo" value={preview.duplicated} />
                  <MiniStat label="Linhas" value={preview.total} />
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <MiniStat label="Até 90 dias" value={preview.recency.d90} />
                  <MiniStat label="91 a 180 dias" value={preview.recency.d180} />
                  <MiniStat label="+180 dias" value={preview.recency.older} />
                  <MiniStat label="Sem data" value={preview.recency.unknown} />
                </div>
                <p className="text-xs text-zinc-500">
                  Arquivo: <b>{preview.file}</b> · colunas reconhecidas: {preview.columns.found.join(', ')}
                  {preview.columns.missing.length ? ` · sem: ${preview.columns.missing.join(', ')}` : ''}. Quem já estiver na lista não é duplicado.
                </p>
                <Field label="Nome da lista"><Input value={listName} onChange={(e) => setListName(e.target.value)} maxLength={80} placeholder="Ex.: Checkout antigo" /></Field>
                {progress && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-zinc-600">Importando… {progress.done} de {progress.total}</p>
                    <div className="h-2 overflow-hidden rounded-full bg-zinc-100"><div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} /></div>
                  </div>
                )}
                <div className="flex flex-wrap justify-end gap-2">
                  <Button type="button" variant="ghost" disabled={Boolean(progress)} onClick={() => setPreview(null)}>Cancelar</Button>
                  <Button type="button" loading={Boolean(progress)} disabled={!preview.rows.length} onClick={() => void doImport()}>Importar {preview.rows.length} contatos</Button>
                </div>
              </div>
            ) : (
              <p className="rounded-xl border border-dashed border-zinc-200 px-4 py-6 text-center text-sm text-zinc-500">
                Escolha o arquivo .csv com nome, telefone (WhatsApp), e-mail, produto e data da compra. A prévia aparece aqui antes de importar.
              </p>
            )}
          </Section>

          <Card title="Listas importadas">
            {!contacts?.lists.length ? (
              <EmptyState icon={<Users className="h-6 w-6" />} title="Nenhuma lista ainda" text="Importe o CSV do seu outro checkout para começar." />
            ) : (
              <ul className="space-y-3">
                {contacts.lists.map((l) => {
                  const done = l.sent + l.queued + l.skipped;
                  return (
                    <li key={l.name} className="rounded-xl border border-zinc-200 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-medium">{l.name}</span>
                        <span className="text-xs text-zinc-500">{l.total} contatos</span>
                        <button type="button" className="text-xs font-semibold text-red-600 hover:underline" onClick={() => confirm(`Apagar a lista "${l.name}"? Quem ainda não recebeu sai da lista; o histórico de quem recebeu fica.`) && remove.mutate(l.name)}>Apagar</button>
                      </div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-100"><div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.round((done / Math.max(1, l.total)) * 100)}%` }} /></div>
                      <p className="mt-1.5 text-xs text-zinc-500">{l.sent + l.queued} receberam · {l.pending} na espera · {l.skipped} pulados</p>
                    </li>
                  );
                })}
              </ul>
            )}
            {Boolean(contacts?.skip_reasons.length) && (
              <div className="mt-4 border-t border-zinc-100 pt-3">
                <p className="text-xs font-semibold text-zinc-700">Por que alguns foram pulados</p>
                <ul className="mt-1 space-y-0.5 text-xs text-zinc-500">
                  {contacts!.skip_reasons.map((r) => <li key={r.reason}>{r.reason}: <b>{r.count}</b></li>)}
                </ul>
              </div>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <Section
            title="Enviar para os importados"
            desc="A mesma sequência do upsell (texto → áudio da apresentação → link da página), mais recentes primeiro. Para quem não comprar, vem a última chamada. Pausa sozinho se muita gente pedir para sair ou se os envios falharem."
            on={c.contacts.enabled}
            onToggle={(v) => setC({ ...c, contacts: { ...c.contacts, enabled: v } })}
          >
            <Field label="1ª mensagem para os importados" hint="Use {nome} e {produto_comprado} (o último material que a pessoa comprou).">
              <Textarea rows={5} value={c.contacts.opener} onChange={(e) => setC({ ...c, contacts: { ...c.contacts, opener: e.target.value } })} />
            </Field>
            <Rhythm c={c} setC={setC} />
            {!c.upsell.enabled && <p className="text-xs font-medium text-amber-600">O upsell (aba Upsell) precisa estar ligado: os importados usam o mesmo áudio e a mesma página.</p>}
          </Section>
        </div>
      </div>
    </div>
  );
}

/** Marca vários produtos (botões com caixinha, como na vitrine da área de membros). */
function ProductPicker({ label, hint, empty, products, value, onChange }: { label: string; hint: string; empty: string; products: Data['products']; value: string[]; onChange: (ids: string[]) => void }) {
  const [q, setQ] = useState('');
  const list = products.filter((p) => (p.active || value.includes(p.id)) && p.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div>
      <p className="text-sm font-medium text-gray-700">{label}</p>
      <p className="mb-2 text-xs text-zinc-500">{hint}</p>
      {products.length > 8 && <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar produto…" className="mb-2 sm:max-w-sm" />}
      <div className="flex max-h-56 flex-wrap gap-2 overflow-y-auto">
        {list.map((p) => {
          const on = value.includes(p.id);
          return (
            <label key={p.id} className={cn('flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm transition', on ? 'border-blue-600 bg-blue-600 text-white' : 'border-zinc-200 text-zinc-600 hover:border-zinc-300')}>
              <input type="checkbox" className="h-4 w-4 accent-white" checked={on} onChange={() => onChange(on ? value.filter((x) => x !== p.id) : [...value, p.id])} />
              {p.name}
            </label>
          );
        })}
      </div>
      {!value.length && <p className="mt-1.5 text-xs font-medium text-amber-600">{empty}</p>}
      {value.length > 0 && <p className="mt-1.5 text-xs text-zinc-500">{value.length} {value.length === 1 ? 'produto marcado' : 'produtos marcados'}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ descadastro (SAIR)
function OptOutCard({ data, onChange, fail }: { data: Data; onChange: () => void; fail: (e: unknown) => void }) {
  const toast = useToast();
  const wa = useQuery({ queryKey: ['whatsapp-config'], queryFn: () => adminApi.get<{ instances: { name: string; active: boolean }[] }>('/whatsapp') });
  type HookRes = { ok: boolean; message: string; current?: string | null };
  const hook = useMutation<HookRes, unknown, { name: string; force?: boolean }>({
    mutationFn: (p: { name: string; force?: boolean }) => adminApi.post<HookRes>(`/whatsapp/instances/${encodeURIComponent(p.name)}/optout-webhook`, { force: p.force }),
    onSuccess: (r, p): void => {
      if (r.ok) return void toast.ok(`${p.name}: ${r.message}`);
      if (r.current && confirm(`${r.message}\n\nEndereço atual: ${r.current}\n\nTrocar mesmo assim?`)) return void hook.mutate({ name: p.name, force: true });
      toast.err(r.message);
    },
    onError: fail,
  });
  const remove = useMutation({ mutationFn: (phone: string) => adminApi.del(`/whatsapp/audio/optouts/${phone}`), onSuccess: () => (toast.ok('Número liberado'), onChange()), onError: fail });
  const instances = (wa.data?.instances ?? []).filter((i) => i.active);

  return (
    <Card title="Descadastro (SAIR)">
      {toast.node}
      <p className="text-sm text-zinc-600">Quem responder <b>SAIR</b>, <b>PARAR</b> ou <b>CANCELAR</b> não recebe mais lembretes nem ofertas. Para isso, a Evolution precisa avisar o checkout das mensagens recebidas: ligue em cada número.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {instances.map((i) => (
          <Button key={i.name} type="button" variant="secondary" size="sm" loading={hook.isPending && hook.variables?.name === i.name} onClick={() => hook.mutate({ name: i.name })}>
            Ligar SAIR em {i.name}
          </Button>
        ))}
        {!instances.length && <p className="text-xs text-zinc-500">Nenhuma instância ativa em Integrações → WhatsApp.</p>}
      </div>
      <p className="mt-2 break-all text-[11px] text-zinc-400">Endereço: {data.webhook_url}</p>

      <h4 className="mt-5 text-sm font-semibold text-zinc-800">Descadastrados ({data.optouts.length})</h4>
      {!data.optouts.length ? (
        <p className="mt-1 text-xs text-zinc-500">Ninguém pediu para sair ainda.</p>
      ) : (
        <ul className="mt-2 divide-y divide-zinc-100 text-sm">
          {data.optouts.map((o) => (
            <li key={o.phone} className="flex items-center gap-2 py-1.5">
              <UserX className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
              <span className="flex-1 tabular-nums">{phoneFmt(o.phone)}</span>
              <span className="text-xs text-zinc-500">{o.word ?? ''} · {dateTime(o.created_at)}</span>
              <button type="button" className="text-xs text-blue-600 hover:underline" onClick={() => confirm('Voltar a enviar mensagens para este número?') && remove.mutate(o.phone)}>liberar</button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ fila
function QueueCard({ rows }: { rows: QueueRow[] }) {
  const label = (r: QueueRow) =>
    r.kind === 'upsell' ? `${r.attempt === 2 ? 'Última chamada' : 'Upsell'}${r.contact_id ? ' · importado' : ''}` : `Recuperação${r.attempt ? ` · ${r.attempt}º` : ''}`;
  return (
    <Card title="Fila de envios (últimos 30)">
      {!rows.length ? (
        <EmptyState icon={<Mic className="h-6 w-6" />} title="Nada na fila ainda" text="Os envios aparecem aqui assim que alguém entrar num lembrete com áudio ou comprar." />
      ) : (
        <div className="-mx-5 overflow-x-auto">
          <table className="w-full min-w-[620px] text-sm">
            <thead>
              <tr className="text-left text-xs text-zinc-500">
                <th className="px-5 py-2 font-medium">Tipo</th>
                <th className="py-2 font-medium">Número</th>
                <th className="py-2 font-medium">Situação</th>
                <th className="py-2 font-medium">Próximo passo</th>
                <th className="px-5 py-2 font-medium">Quando</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-5 py-2">{label(r)}</td>
                  <td className="py-2 tabular-nums">{phoneFmt(r.phone)}</td>
                  <td className="py-2">
                    <Badge tone={queueTone[r.status] ?? 'off'}>{queueText[r.status] ?? r.status}</Badge>
                    {r.error && <p className="mt-0.5 max-w-[260px] truncate text-xs text-zinc-500" title={r.error}>{r.error}</p>}
                  </td>
                  <td className="py-2 text-zinc-600">{r.status === 'pending' ? stepText(r) : '—'}</td>
                  <td className="px-5 py-2 text-zinc-600">{dateTime(r.status === 'pending' ? r.run_at : r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
