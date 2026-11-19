import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mic, Send, Trash2, Upload, UserX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, cn, EmptyState, Field, Input, PageLoader, Select, Switch, Textarea, useToast } from '@/components/ui';
import { adminApi, ApiError } from '@/lib/api';
import { brl, dateTime } from '@/lib/format';
import { supabase } from '@/lib/supabase';
import { PageHeader } from './AdminApp';

/**
 * Áudios no WhatsApp (pela Evolution):
 *  - Recuperação: o 3º (último) lembrete vai por áudio + link/Pix.
 *  - Upsell: ~2 h depois da compra → texto curto → áudio → link com a validade da oferta.
 * Relatório por áudio, descadastro (SAIR) e a fila de envios.
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
  upsell: { enabled: boolean; checkout_slug: string; page_slug: string; product_ids: string[]; delayMinutes: number; validityHours: number; gapSeconds: number; opener: string; linkText: string };
  backfill: { enabled: boolean; daysBack: number; intervalMinutes: number };
  upsell2: { enabled: boolean; delayHours: number; firstMonthCents: number; validityHours: number; audio: string; opener: string; linkText: string };
}
interface QueueRow { id: string; kind: Kind; attempt?: number | null; step: number; status: string; phone: string; run_at: string; error: string | null; created_at: string }
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
}

const kindLabel: Record<Kind, string> = { recovery: 'Recuperação', upsell: 'Upsell' };
const queueText: Record<string, string> = { pending: 'Na fila', sending: 'Enviando', done: 'Enviado', skipped: 'Pulado', failed: 'Falhou', canceled: 'Cancelado' };
const queueTone: Record<string, string> = { pending: 'pending', sending: 'info', done: 'paid', skipped: 'off', failed: 'failed', canceled: 'canceled' };
const stepText = (r: QueueRow) =>
  r.kind === 'upsell' ? (['Texto de abertura', 'Áudio', 'Link'][r.step] ?? '') : (['Texto de abertura', 'Áudio', 'Link + Pix'][r.step] ?? '');
const phoneFmt = (p: string) => p.replace(/^55(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3');

export default function AudiosPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error } = useQuery({ queryKey: ['wa-audio'], queryFn: () => adminApi.get<Data>('/whatsapp/audio') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['wa-audio'] });
  const fail = (e: unknown) => toast.err(e instanceof ApiError ? e.message : 'Erro');

  if (isLoading) return <PageLoader />;
  if (error || !data) return <Card><p className="text-sm text-red-600">{error instanceof ApiError ? error.message : 'Não foi possível carregar.'}</p></Card>;

  return (
    <>
      {toast.node}
      <PageHeader title="Áudios no WhatsApp" subtitle="3º lembrete da recuperação por áudio e upsell (texto → áudio → link). Tudo pela Evolution, das 8h às 20h." />
      {data.ready && data.attempt_ready === false && (
        <Card className="mb-4 border-amber-300 bg-amber-50">
          <p className="text-sm font-medium text-amber-800">Rode no Supabase o SQL da recuperação em mais de um lembrete (supabase/migrations/20261122000000_wa_queue_attempt.sql). Até lá, a recuperação segue em texto.</p>
        </Card>
      )}
      {!data.ready && (
        <Card className="mb-4 border-amber-300 bg-amber-50">
          <p className="text-sm font-medium text-amber-800">{data.sql_hint}</p>
        </Card>
      )}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="min-w-0 space-y-4">
          <AudioList data={data} onChange={refresh} fail={fail} />
          <QueueCard rows={data.queue} />
        </div>
        <div className="min-w-0 space-y-4">
          <ConfigCard data={data} onSaved={refresh} fail={fail} />
          <OptOutCard data={data} onChange={refresh} fail={fail} />
        </div>
      </div>
    </>
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
    <Card title="Áudios e resultados">
      {toast.node}
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
      <p className="mt-2 text-xs text-zinc-500">Grave no celular (mp3, ogg ou m4a, até 16 MB). Com mais de um áudio ativo do mesmo tipo, eles se revezam: compare abaixo qual vende mais.</p>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input value={testPhone} onChange={(e) => setTestPhone(e.target.value)} placeholder="Seu WhatsApp para testar (DDD + número)" className="sm:max-w-xs" />
        <span className="text-xs text-zinc-500">Use o botão "Testar" de um áudio para recebê-lo neste número.</span>
      </div>

      {groups.map((g) => {
        const list = data.audios.filter((a) => a.kind === g);
        return (
          <div key={g} className="mt-6">
            <h4 className="mb-2 text-sm font-semibold text-zinc-800">{kindLabel[g]}</h4>
            {!list.length ? (
              <p className="rounded-xl border border-dashed border-zinc-200 px-4 py-5 text-center text-sm text-zinc-500">
                {g === 'recovery' ? 'Sem áudio: os lembretes continuam indo em texto.' : 'Sem áudio: o upsell não é enviado.'}
              </p>
            ) : (
              <div className="space-y-3">
                {list.map((a) => (
                  <div key={a.id} className={cn('rounded-xl border p-3', a.active ? 'border-zinc-200' : 'border-zinc-200 bg-zinc-50 opacity-70')}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Mic className="h-4 w-4 text-zinc-500" />
                      <span className="min-w-0 flex-1 truncate font-medium">{a.name}</span>
                      <Switch checked={a.active} onChange={() => toggle.mutate(a)} label={a.active ? 'Ativo' : 'Pausado'} />
                    </div>
                    <audio controls preload="none" src={a.file_url} className="mt-2 h-9 w-full" />
                    <div className="mt-3 grid grid-cols-3 gap-2 text-center sm:grid-cols-6">
                      <Stat label="Enviados" value={a.sent} />
                      <Stat label="Cliques" value={a.clicks} />
                      <Stat label="Pedidos" value={a.orders} />
                      <Stat label="Pagos" value={a.paid} />
                      <Stat label="Faturamento" value={<span className="pv">{brl(a.revenue_cents)}</span>} />
                      <Stat label="Conversão" value={`${a.conversion.toLocaleString('pt-BR')}%`} />
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
          </div>
        );
      })}
    </Card>
  );
}
const Stat = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="rounded-lg bg-zinc-50 px-2 py-1.5">
    <p className="text-[11px] text-zinc-500">{label}</p>
    <p className="text-sm font-semibold tabular-nums">{value}</p>
  </div>
);

// ------------------------------------------------------------------ configuração
function ConfigCard({ data, onSaved, fail }: { data: Data; onSaved: () => void; fail: (e: unknown) => void }) {
  const toast = useToast();
  const [c, setC] = useState<Config>(data.config);
  useEffect(() => setC(data.config), [data.config]);
  const up = (p: Partial<Config['upsell']>) => setC({ ...c, upsell: { ...c.upsell, ...p } });
  const save = useMutation({ mutationFn: () => adminApi.put('/whatsapp/audio/config', c), onSuccess: () => (toast.ok('Configuração salva'), onSaved()), onError: fail });
  const num = (v: string) => Math.max(0, Math.floor(Number(v) || 0));

  return (
    <Card title="Configuração">
      {toast.node}
      <div className="space-y-4">
        <Switch checked={c.enabled} onChange={(v) => setC({ ...c, enabled: v })} label="Áudios ligados" />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Enviar a partir de (h)"><Input type="number" min={0} max={23} value={c.windowStart} onChange={(e) => setC({ ...c, windowStart: num(e.target.value) })} /></Field>
          <Field label="Até (h)"><Input type="number" min={1} max={24} value={c.windowEnd} onChange={(e) => setC({ ...c, windowEnd: num(e.target.value) })} /></Field>
        </div>
        <p className="-mt-2 text-xs text-zinc-500">Horário de Brasília. Fora dele, o envio espera a próxima abertura.</p>

        <div className="border-t border-zinc-100 pt-4">
          <Switch checked={c.recovery.enabled} onChange={(v) => setC({ ...c, recovery: { ...c.recovery, enabled: v } })} label="Recuperação por áudio" />
          <p className="mt-1 text-xs text-zinc-500">Nos lembretes marcados vai a sequência: texto curto → áudio → link + Pix. Os outros lembretes seguem em texto. Fora do horário de envio, o lembrete vai em texto na hora (não atrasa).</p>
          <div className="mt-3">
            <p className="mb-1.5 text-sm font-medium text-gray-700">Lembretes com áudio</p>
            <div className="flex flex-wrap gap-2">
              {[1, 2, 3].map((n) => {
                const on = c.recovery.attempts.includes(n);
                return (
                  <label key={n} className={cn('flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm transition', on ? 'border-blue-600 bg-blue-600 text-white' : 'border-zinc-200 text-zinc-600 hover:border-zinc-300')}>
                    <input type="checkbox" className="h-4 w-4 accent-white" checked={on} onChange={() => setC({ ...c, recovery: { ...c.recovery, attempts: on ? c.recovery.attempts.filter((x) => x !== n) : [...c.recovery.attempts, n].sort() } })} />
                    {n}º lembrete{n === 3 ? ' (último)' : ''}
                  </label>
                );
              })}
            </div>
          </div>
          <div className="mt-3 grid gap-3">
            <Field label="1ª mensagem (no 1º lembrete)" hint="Use {nome} e {produto}."><Textarea rows={2} value={c.recovery.opener} onChange={(e) => setC({ ...c, recovery: { ...c.recovery, opener: e.target.value } })} /></Field>
            <Field label="1ª mensagem (no último lembrete com áudio)"><Textarea rows={2} value={c.recovery.openerLast} onChange={(e) => setC({ ...c, recovery: { ...c.recovery, openerLast: e.target.value } })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              {([['audioFirst', 'Áudio do 1º lembrete'], ['audioLast', 'Áudio do último']] as const).map(([k, label]) => (
                <Field key={k} label={label}>
                  <Select value={c.recovery[k]} onChange={(e) => setC({ ...c, recovery: { ...c.recovery, [k]: e.target.value } })}>
                    <option value="">Revezar os ativos</option>
                    {data.audios.filter((a) => a.kind === 'recovery').map((a) => <option key={a.id} value={a.id}>{a.name}{a.active ? '' : ' (pausado)'}</option>)}
                  </Select>
                </Field>
              ))}
            </div>
            <p className="-mt-1 text-xs text-zinc-500">“Revezar os ativos” sorteia entre os áudios de recuperação ativos (compare no relatório qual vende mais). O áudio escolhido para um lembrete nunca entra no revezamento do outro.</p>
            <Field label="Áudio sai após (s)" hint="Tempo entre a 1ª mensagem e o áudio"><Input type="number" min={10} value={c.recovery.gapSeconds} onChange={(e) => setC({ ...c, recovery: { ...c.recovery, gapSeconds: num(e.target.value) } })} /></Field>
          </div>
          <ProductPicker
            label="Produtos com recuperação por áudio"
            hint="Pix pendente de um destes produtos recebe os lembretes marcados com áudio. Os outros seguem em texto."
            empty="Nenhum marcado: todos os lembretes seguem em texto."
            products={data.products}
            value={c.recovery.product_ids}
            onChange={(ids) => setC({ ...c, recovery: { ...c.recovery, product_ids: ids } })}
          />
          <Field label="Mensagem depois do áudio" hint="Use {nome}, {produto}, {valor}, {link} e {pix} (aviso do Pix copia e cola, só quando o Pix ainda vale).">
            <Textarea rows={4} value={c.recovery.linkText} onChange={(e) => setC({ ...c, recovery: { ...c.recovery, linkText: e.target.value } })} />
          </Field>
        </div>

        <div className="space-y-3 border-t border-zinc-100 pt-4">
          <Switch checked={c.upsell.enabled} onChange={(v) => up({ enabled: v })} label="Upsell por áudio depois da compra" />
          <ProductPicker
            label="Quem comprou (produtos pagos)"
            hint="Recebe o upsell quem PAGOU um destes produtos (como produto principal ou order bump)."
            empty="Nenhum marcado: o upsell não é enviado."
            products={data.products}
            value={c.upsell.product_ids}
            onChange={(ids) => up({ product_ids: ids })}
          />
          <Field label="Página de vendas (link do áudio)" hint="Escolhida: o link do áudio leva para a página upsell (vídeo + Pix na página). Sem página: leva ao checkout abaixo.">
            <Select value={c.upsell.page_slug} onChange={(e) => up({ page_slug: e.target.value })}>
              <option value="">Nenhuma (usar o checkout)</option>
              {data.pages.map((p) => (
                <option key={p.slug} value={p.slug}>{p.title} (/oferta/{p.slug}){p.active ? '' : ' · pausada'}</option>
              ))}
            </Select>
          </Field>
          <Field label="Checkout oferecido" hint="Usado quando não há página escolhida. Quem já comprou ou assina não recebe.">
            <Select value={c.upsell.checkout_slug} onChange={(e) => up({ checkout_slug: e.target.value })}>
              <option value="">Escolha…</option>
              {data.checkouts.map((k) => (
                <option key={k.slug} value={k.slug}>{k.name} ({k.slug})</option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Enviar após (min)"><Input type="number" min={10} value={c.upsell.delayMinutes} onChange={(e) => up({ delayMinutes: num(e.target.value) })} /></Field>
            <Field label="Validade (h)"><Input type="number" min={1} value={c.upsell.validityHours} onChange={(e) => up({ validityHours: num(e.target.value) })} /></Field>
            <Field label="Áudio após (s)"><Input type="number" min={10} value={c.upsell.gapSeconds} onChange={(e) => up({ gapSeconds: num(e.target.value) })} /></Field>
          </div>
          <Field label="1ª mensagem (texto)"><Textarea rows={2} value={c.upsell.opener} onChange={(e) => up({ opener: e.target.value })} /></Field>
          <Field label="Mensagem depois do áudio (com o link)" hint="Use {nome}, {produto}, {link} e {validade}.">
            <Textarea rows={5} value={c.upsell.linkText} onChange={(e) => up({ linkText: e.target.value })} />
          </Field>
          <p className="text-xs text-zinc-500">No máximo 1 upsell a cada 7 dias por pessoa. Link rastreável com UTMs whatsapp / audio / upsell / id do áudio.</p>
        </div>

        <div className="space-y-3 border-t border-zinc-100 pt-4">
          <Switch checked={c.upsell2.enabled} onChange={(v) => setC({ ...c, upsell2: { ...c.upsell2, enabled: v } })} label="Última chamada (upsell 2) com desconto no 1º mês" />
          <p className="text-xs text-zinc-500">Para quem recebeu o upsell e não comprou: texto → áudio próprio → link da página de vendas com o <b>1º mês por um preço menor</b>. Os meses seguintes seguem pelo preço normal. O desconto só vale pelo link e só até a validade (nenhum cupom aparece na página). Precisa da página de vendas escolhida acima.</p>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Enviar após (h)"><Input type="number" min={1} max={168} value={c.upsell2.delayHours} onChange={(e) => setC({ ...c, upsell2: { ...c.upsell2, delayHours: num(e.target.value) } })} /></Field>
            <Field label="1º mês por (R$)"><Input type="number" min={1} step={0.01} value={c.upsell2.firstMonthCents / 100} onChange={(e) => setC({ ...c, upsell2: { ...c.upsell2, firstMonthCents: Math.max(100, Math.round(Number(e.target.value) * 100) || 100) } })} /></Field>
            <Field label="Validade (h)"><Input type="number" min={1} max={168} value={c.upsell2.validityHours} onChange={(e) => setC({ ...c, upsell2: { ...c.upsell2, validityHours: num(e.target.value) } })} /></Field>
          </div>
          <Field label="Áudio da última chamada" hint="Suba um áudio do tipo Upsell só para esta chamada. Ele não entra no revezamento do 1º upsell.">
            <Select value={c.upsell2.audio} onChange={(e) => setC({ ...c, upsell2: { ...c.upsell2, audio: e.target.value } })}>
              <option value="">Revezar os áudios de upsell ativos</option>
              {data.audios.filter((a) => a.kind === 'upsell').map((a) => <option key={a.id} value={a.id}>{a.name}{a.active ? '' : ' (pausado)'}</option>)}
            </Select>
          </Field>
          <Field label="1ª mensagem" hint="Use {nome} e {produto}."><Textarea rows={2} value={c.upsell2.opener} onChange={(e) => setC({ ...c, upsell2: { ...c.upsell2, opener: e.target.value } })} /></Field>
          <Field label="Mensagem depois do áudio (com o link)" hint="Use {nome}, {produto}, {link}, {preco} (1º mês), {preco_normal} e {validade}.">
            <Textarea rows={5} value={c.upsell2.linkText} onChange={(e) => setC({ ...c, upsell2: { ...c.upsell2, linkText: e.target.value } })} />
          </Field>
          {c.upsell2.enabled && !c.upsell.page_slug && <p className="text-xs font-medium text-amber-600">Escolha a página de vendas em “Página de vendas (link do áudio)”: a última chamada só funciona com ela.</p>}
        </div>

        <div className="space-y-3 border-t border-zinc-100 pt-4">
          <Switch checked={c.backfill.enabled} onChange={(v) => setC({ ...c, backfill: { ...c.backfill, enabled: v } })} label="Enviar o upsell para compradores antigos" />
          <p className="text-xs text-zinc-500">Quem já comprou um dos produtos marcados acima recebe a mesma sequência (texto → áudio → link), <b>uma pessoa por vez</b>, espaçado, só no horário de envio. Começa pelos mais recentes. Cada pessoa recebe uma vez só; assinantes, quem já comprou e quem respondeu SAIR ficam de fora.</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="1 pessoa a cada (min)"><Input type="number" min={10} value={c.backfill.intervalMinutes} onChange={(e) => setC({ ...c, backfill: { ...c.backfill, intervalMinutes: num(e.target.value) } })} /></Field>
            <Field label="Compras dos últimos (dias)"><Input type="number" min={1} max={730} value={c.backfill.daysBack} onChange={(e) => setC({ ...c, backfill: { ...c.backfill, daysBack: num(e.target.value) } })} /></Field>
          </div>
          {data.backfill && (
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-zinc-50 px-2 py-1.5"><p className="text-[11px] text-zinc-500">Já enviados</p><p className="text-sm font-semibold tabular-nums">{data.backfill.sent}</p></div>
              <div className="rounded-lg bg-zinc-50 px-2 py-1.5"><p className="text-[11px] text-zinc-500">Faltam (aprox.)</p><p className="text-sm font-semibold tabular-nums">{data.backfill.remaining}</p></div>
              <div className="rounded-lg bg-zinc-50 px-2 py-1.5"><p className="text-[11px] text-zinc-500">Próximo</p><p className="text-sm font-semibold tabular-nums">{data.backfill.next_at ? new Date(data.backfill.next_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—'}</p></div>
            </div>
          )}
          {c.backfill.enabled && data.backfill && (
            <p className="text-xs text-zinc-500">No ritmo de 1 a cada {c.backfill.intervalMinutes} min, são cerca de {Math.floor(((c.windowEnd - c.windowStart) * 60) / Math.max(10, c.backfill.intervalMinutes))} por dia{data.backfill.remaining ? `: todos em ~${Math.max(1, Math.ceil(data.backfill.remaining / Math.max(1, Math.floor(((c.windowEnd - c.windowStart) * 60) / Math.max(10, c.backfill.intervalMinutes)))))} dia(s)` : ''}.</p>
          )}
        </div>
        <Button type="button" className="w-full" loading={save.isPending} onClick={() => save.mutate()}>Salvar configuração</Button>
      </div>
    </Card>
  );
}

/** Marca vários produtos (botões com caixinha, como na vitrine da área de membros). */
function ProductPicker({ label, hint, empty, products, value, onChange }: { label: string; hint: string; empty: string; products: Data['products']; value: string[]; onChange: (ids: string[]) => void }) {
  const [q, setQ] = useState('');
  const list = products.filter((p) => (p.active || value.includes(p.id)) && p.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="mt-3">
      <p className="text-sm font-medium text-gray-700">{label}</p>
      <p className="mb-2 text-xs text-zinc-500">{hint}</p>
      {products.length > 8 && <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar produto…" className="mb-2" />}
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
  return (
    <Card title="Fila de envios (últimos 30)">
      {!rows.length ? (
        <EmptyState icon={<Mic className="h-6 w-6" />} title="Nada na fila ainda" text="Os envios aparecem aqui assim que alguém entrar no 3º lembrete ou comprar." />
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
                  <td className="px-5 py-2">{r.kind === 'upsell' ? 'Upsell' : `Recuperação${r.attempt ? ` · ${r.attempt}º` : ''}`}</td>
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
