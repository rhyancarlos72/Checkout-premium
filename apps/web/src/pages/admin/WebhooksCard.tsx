import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Eye, EyeOff, Pencil, Plus, PlugZap, Trash2, Webhook as WebhookIcon, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, cn, Field, Input, Modal, PageLoader, Switch } from '@/components/ui';
import { adminApi, ApiError } from '@/lib/api';
import { dateTime } from '@/lib/format';

interface WebhookRow {
  id: string;
  name: string;
  preset: 'paytracking' | 'custom';
  url: string;
  events: string[];
  active: boolean;
  fromEnv?: boolean;
  token_hint: string;
  has_secret: boolean;
  last: { ok: boolean; http_status: number | null; message: string; created_at: string } | null;
}

const EVENT_LABEL: Record<string, string> = {
  'sale.pending': 'Pix gerado',
  'sale.approved': 'Venda aprovada',
  'sale.canceled': 'Pix expirado/cancelado',
  'sale.refunded': 'Reembolso',
};
const PAYTRACKING_URL = 'https://paytracking.com.br/api/webhook.php';

type Toast = { ok: (m: string) => void; err: (m: string) => void };

/** Integrações → Webhooks: envia os eventos de venda (formato PayTracking) para URLs configuradas aqui. */
export function WebhooksCard({ toast }: { toast: Toast }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['webhooks'], queryFn: () => adminApi.get<{ items: WebhookRow[]; events: string[] }>('/webhooks') });
  const [editing, setEditing] = useState<WebhookRow | 'new' | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['webhooks'] });

  const test = useMutation({
    mutationFn: (id: string) => adminApi.post<{ ok: boolean; message: string }>(`/webhooks/${id}/test`),
    onSuccess: (r) => ((r.ok ? toast.ok : toast.err)(r.message), refresh()),
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro'),
  });
  const toggle = useMutation({
    mutationFn: (w: WebhookRow) => adminApi.put(`/webhooks/${w.id}`, { name: w.name, preset: w.preset, url: w.url, events: w.events, active: !w.active }),
    onSuccess: refresh,
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => adminApi.del(`/webhooks/${id}`),
    onSuccess: () => (refresh(), toast.ok('Webhook removido')),
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro'),
  });

  return (
    <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white lg:col-span-2">
      <header className="flex flex-col gap-3 border-b border-zinc-100 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600"><WebhookIcon className="h-5 w-5" /></div>
          <div>
            <h3 className="font-display font-semibold text-zinc-900">Webhooks · PayTracking</h3>
            <p className="text-sm text-zinc-500">Cada venda é enviada para as URLs abaixo, assinada com o token e o segredo de cada webhook.</p>
          </div>
        </div>
        <Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Adicionar webhook</Button>
      </header>

      {isLoading ? (
        <PageLoader />
      ) : !data?.items.length ? (
        <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
          <p className="text-sm text-zinc-500">Nenhum webhook ainda. Conecte o PayTracking para enviar as vendas (com order bumps) e o Purchase para a Meta.</p>
          <Button variant="secondary" onClick={() => setEditing('new')}><PlugZap className="h-4 w-4" /> Conectar PayTracking</Button>
        </div>
      ) : (
        <ul className="divide-y divide-zinc-100">
          {data.items.map((w) => (
            <li key={w.id} className="flex flex-col gap-3 p-5 lg:flex-row lg:items-center">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold text-zinc-900">{w.name}</p>
                  {w.preset === 'paytracking' && <Badge tone="on">PayTracking</Badge>}
                  {w.fromEnv && <Badge tone="off">variáveis de ambiente</Badge>}
                  {!w.active && <Badge tone="off">pausado</Badge>}
                </div>
                <p className="mt-0.5 truncate font-mono text-xs text-zinc-500">{w.url}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {w.events.map((e) => <span key={e} className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600">{EVENT_LABEL[e] ?? e}</span>)}
                  <span className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-600">token {w.token_hint || '—'}</span>
                  <span className={cn('rounded-md px-1.5 py-0.5 text-[11px] font-medium', w.has_secret ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700')}>{w.has_secret ? 'assinatura HMAC ativa' : 'sem segredo de assinatura'}</span>
                </div>
                {w.last && (
                  <p className={cn('mt-2 flex items-center gap-1.5 text-xs', w.last.ok ? 'text-emerald-700' : 'text-red-600')}>
                    {w.last.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                    <span className="truncate">Último envio {dateTime(w.last.created_at)}: {w.last.message}</span>
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {!w.fromEnv && <Switch checked={w.active} onChange={() => toggle.mutate(w)} />}
                <Button size="sm" variant="secondary" loading={test.isPending && test.variables === w.id} onClick={() => test.mutate(w.id)}><PlugZap className="h-3.5 w-3.5" /> Testar</Button>
                {!w.fromEnv && <Button size="sm" variant="ghost" aria-label="Editar" onClick={() => setEditing(w)}><Pencil className="h-4 w-4" /></Button>}
                {!w.fromEnv && <Button size="sm" variant="ghost" aria-label="Excluir" onClick={() => confirm(`Remover o webhook "${w.name}"?`) && remove.mutate(w.id)}><Trash2 className="h-4 w-4" /></Button>}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-zinc-100 bg-zinc-50 px-5 py-3 text-xs leading-relaxed text-zinc-500">
        Cada envio vai por <b>POST</b> em JSON com <code>Authorization: Bearer &lt;token&gt;</code> e, se houver segredo, <code>X-Paytrack-Signature: sha256=HMAC(timestamp.corpo)</code> + <code>X-Paytrack-Timestamp</code>. Tentativas automáticas em falhas de rede/5xx.
      </div>

      {editing && <WebhookForm webhook={editing === 'new' ? null : editing} events={data?.events ?? Object.keys(EVENT_LABEL)} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), refresh(), toast.ok('Webhook salvo'))} />}
    </section>
  );
}

function WebhookForm({ webhook, events, onClose, onSaved }: { webhook: WebhookRow | null; events: string[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    preset: webhook?.preset ?? 'paytracking',
    name: webhook?.name ?? 'PayTracking',
    url: webhook?.url ?? PAYTRACKING_URL,
    token: '',
    secret: '',
    events: webhook?.events ?? [...events],
    active: webhook?.active ?? true,
  });
  const [show, setShow] = useState(false);
  const [clearSecret, setClearSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));

  async function submit() {
    setError(null);
    if (!webhook && f.preset === 'paytracking' && !f.token) return setError('Cole o token da sua integração no PayTracking');
    setBusy(true);
    try {
      const body = { ...f, token: f.token || undefined, secret: f.secret || undefined, ...(webhook && { clear_secret: clearSecret }) };
      if (webhook) await adminApi.put(`/webhooks/${webhook.id}`, body);
      else await adminApi.post('/webhooks', body);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao salvar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={webhook ? `Editar webhook · ${webhook.name}` : 'Adicionar webhook'}>
      <div className="space-y-4">
        {!webhook && (
          <div className="grid grid-cols-2 gap-2">
            {[
              { v: 'paytracking', t: 'PayTracking', d: 'URL já preenchida' },
              { v: 'custom', t: 'Outro sistema', d: 'Qualquer URL https' },
            ].map((o) => (
              <button key={o.v} type="button" onClick={() => set(o.v === 'paytracking' ? { preset: 'paytracking', name: 'PayTracking', url: PAYTRACKING_URL } : { preset: 'custom', name: '', url: '' })} className={cn('rounded-xl border-2 p-3 text-left transition', f.preset === o.v ? 'border-blue-500 bg-blue-50/50' : 'border-zinc-200 hover:border-zinc-300')}>
                <p className="font-semibold text-zinc-900">{o.t}</p>
                <p className="text-xs text-zinc-500">{o.d}</p>
              </button>
            ))}
          </div>
        )}
        <Field label="Nome"><Input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="Ex.: PayTracking" /></Field>
        <Field label="URL do webhook" hint={f.preset === 'paytracking' ? 'Use a URL mostrada na sua integração “Checkout próprio” do PayTracking.' : undefined}>
          <Input value={f.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://..." className="font-mono text-sm" />
        </Field>
        <Field label="Token (PAYTRACKING_TOKEN)" hint={webhook ? `Salvo: ${webhook.token_hint || 'nenhum'}. Deixe em branco para manter.` : 'Enviado como Authorization: Bearer'}>
          <div className="relative">
            <Input type={show ? 'text' : 'password'} value={f.token} onChange={(e) => set({ token: e.target.value })} autoComplete="off" placeholder={webhook ? '••••••••' : 'cole o token aqui'} className="pr-11 font-mono text-sm" />
            <button type="button" onClick={() => setShow(!show)} className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-zinc-400" aria-label="Mostrar">{show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
          </div>
        </Field>
        <Field label="Segredo de assinatura (PAYTRACKING_SECRET)" hint={webhook ? (webhook.has_secret ? 'Há um segredo salvo. Deixe em branco para manter.' : 'Nenhum segredo salvo.') : 'Recomendado: o destino recusa envios forjados.'}>
          <Input type={show ? 'text' : 'password'} value={f.secret} onChange={(e) => set({ secret: e.target.value })} autoComplete="off" placeholder={webhook?.has_secret ? '••••••••' : 'cole o segredo aqui'} className="font-mono text-sm" disabled={clearSecret} />
        </Field>
        {webhook?.has_secret && <Switch checked={clearSecret} onChange={setClearSecret} label="Remover o segredo salvo" />}
        <div>
          <p className="mb-2 text-sm font-medium text-zinc-700">Eventos enviados</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {events.map((e) => {
              const on = f.events.includes(e);
              return (
                <button key={e} type="button" onClick={() => set({ events: on ? f.events.filter((x) => x !== e) : [...f.events, e] })} className={cn('flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-sm transition', on ? 'border-blue-500 bg-blue-50/50 text-zinc-900' : 'border-zinc-200 text-zinc-500')}>
                  <span className={cn('flex h-4 w-4 items-center justify-center rounded border', on ? 'border-blue-600 bg-blue-600 text-white' : 'border-zinc-300')}>{on && '✓'}</span>
                  <span className="min-w-0 flex-1" title={e}>{EVENT_LABEL[e] ?? e}</span>
                </button>
              );
            })}
          </div>
        </div>
        <Switch checked={f.active} onChange={(v) => set({ active: v })} label="Ativo" />
        {error && <p className="rounded-xl bg-red-50 px-3 py-2.5 text-sm font-medium text-red-700">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-zinc-100 pt-4">
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button loading={busy} onClick={submit}>Salvar webhook</Button>
        </div>
      </div>
    </Modal>
  );
}
