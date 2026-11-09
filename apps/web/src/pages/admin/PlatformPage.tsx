import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Check, History, Percent, ShieldCheck, UserPlus, Wallet, X } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, cn, EmptyState, Field, Input, Modal, PageLoader, Select, Switch, useToast } from '@/components/ui';
import { adminApi, ApiError } from '@/lib/api';
import { brl, centsToInput, dateTime, parseMoney } from '@/lib/format';
import { PageHeader } from './AdminApp';

interface Producer {
  id: string;
  name: string;
  legal_name: string | null;
  document: string | null;
  phone: string | null;
  status: 'pending' | 'active' | 'suspended';
  owner: boolean;
  pix_provider: 'woovi' | 'efi' | null;
  split_enabled: boolean;
  recipient: { account?: string; document?: string; pix_key?: string; name?: string; payee_code?: string };
  card_split_enabled?: boolean;
  emails: string[];
  products: number;
  gross_cents: number;
  fees_cents: number;
  refunds_cents: number;
  created_at: string;
}
interface Policy { id: string; org_id: string | null; fixed_cents: number; percent_bps: number; bump_cents: number; gateway_fee_payer: string; refund_policy: string; note: string | null; created_at: string; org?: { name: string } | null }
interface Request { id: string; name: string; email: string; phone: string | null; company: string | null; message: string | null; created_at: string }

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Não foi possível salvar');
const tabs = [
  { key: 'produtores', label: 'Produtores', icon: Building2 },
  { key: 'cadastros', label: 'Pedidos de cadastro', icon: UserPlus },
  { key: 'taxas', label: 'Taxas', icon: Percent },
  { key: 'financeiro', label: 'Financeiro', icon: Wallet },
  { key: 'auditoria', label: 'Auditoria', icon: History },
] as const;

/** Super Admin: gestão da plataforma (produtores, cadastros, taxas, financeiro global e auditoria). */
export default function PlatformPage() {
  const [tab, setTab] = useState<(typeof tabs)[number]['key']>('produtores');
  return (
    <>
      <PageHeader title="Plataforma" subtitle="Produtores, comissões da Prime, financeiro de toda a plataforma e registro das ações administrativas." />
      <div className="mb-6 inline-flex flex-wrap gap-1 rounded-2xl border border-zinc-200 bg-white p-1.5">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)} className={cn('flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition', tab === t.key ? 'bg-gradient-to-r from-blue-600 to-blue-500 text-white shadow-md shadow-blue-600/25' : 'text-zinc-600 hover:bg-zinc-100')}>
            <t.icon className="h-4 w-4" /> {t.label}
          </button>
        ))}
      </div>
      {tab === 'produtores' && <Producers />}
      {tab === 'cadastros' && <Requests />}
      {tab === 'taxas' && <Fees />}
      {tab === 'financeiro' && <GlobalFinance />}
      {tab === 'auditoria' && <Audit />}
    </>
  );
}

// ------------------------------------------------------------------ produtores
function Producers() {
  const q = useQuery({ queryKey: ['platform', 'producers'], queryFn: () => adminApi.get<Producer[]>('/platform/producers') });
  const [editing, setEditing] = useState<Producer | null>(null);
  if (q.isLoading) return <PageLoader />;
  if (q.error) return <Card><p className="text-sm text-red-600">{(q.error as Error).message}</p></Card>;
  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {(q.data ?? []).map((p) => (
          <Card key={p.id} className="flex flex-col">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-semibold">{p.name}</p>
                <p className="truncate text-xs text-zinc-500">{p.emails.join(', ') || '—'}{p.document ? ` · ${p.document}` : ''}</p>
              </div>
              {p.owner ? <Badge tone="paid">Proprietária</Badge> : p.status === 'active' ? <Badge tone="paid">Ativo</Badge> : p.status === 'suspended' ? <Badge tone="failed">Suspenso</Badge> : <Badge tone="pending">Em análise</Badge>}
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-zinc-50 p-2"><p className="text-[11px] text-zinc-500">Vendas</p><p className="pv text-sm font-semibold">{brl(p.gross_cents)}</p></div>
              <div className="rounded-xl bg-zinc-50 p-2"><p className="text-[11px] text-zinc-500">Comissões</p><p className="pv text-sm font-semibold">{brl(p.fees_cents)}</p></div>
              <div className="rounded-xl bg-zinc-50 p-2"><p className="text-[11px] text-zinc-500">Produtos</p><p className="text-sm font-semibold">{p.products}</p></div>
            </div>
            <div className="mt-4 flex items-center justify-between gap-2 border-t border-zinc-100 pt-4">
              <p className="text-xs text-zinc-500">{p.owner ? 'Isenta de taxas · recebe como sempre' : p.split_enabled ? `Vendas liberadas · ${p.pix_provider === 'efi' ? 'Efí' : 'Woovi'}` : 'Vendas bloqueadas até configurar o recebimento'}</p>
              {!p.owner && <Button size="sm" variant="secondary" onClick={() => setEditing(p)}>Gerenciar</Button>}
            </div>
          </Card>
        ))}
      </div>
      {editing && <ProducerModal p={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function ProducerModal({ p, onClose }: { p: Producer; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState<{ status: Producer['status']; pix_provider: string; split_enabled: boolean; recipient: Producer['recipient'] & { account: string; document: string; pix_key: string; name: string; payee_code: string }; card_split_enabled: boolean }>({ card_split_enabled: Boolean(p.card_split_enabled), status: p.status === 'pending' ? 'active' : p.status, pix_provider: p.pix_provider ?? '', split_enabled: p.split_enabled, recipient: { account: '', document: '', pix_key: '', name: '', payee_code: '', ...p.recipient } });
  const save = useMutation({
    mutationFn: () => adminApi.put(`/platform/producers/${p.id}`, { ...f, pix_provider: f.pix_provider || null }),
    onSuccess: () => (qc.invalidateQueries({ queryKey: ['platform'] }), onClose()),
    onError: (e) => toast.err(errMsg(e)),
  });
  const setR = (k: keyof typeof f.recipient, v: string) => setF({ ...f, recipient: { ...f.recipient, [k]: v } });
  return (
    <Modal open onClose={onClose} title={`Produtor: ${p.name}`}>
      {toast.node}
      <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
        <Field label="Situação">
          <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as Producer['status'] })}>
            <option value="active">Ativo</option>
            <option value="suspended">Suspenso (não acessa o painel e não vende)</option>
          </Select>
        </Field>
        <Field label="Gateway do produtor" hint="Pix deste produtor é processado por este gateway, com split">
          <Select value={f.pix_provider} onChange={(e) => setF({ ...f, pix_provider: e.target.value })}>
            <option value="">Escolha…</option>
            <option value="efi">Efí Bank</option>
            <option value="woovi">Woovi</option>
          </Select>
        </Field>
        <div className="rounded-xl border border-zinc-200 p-4">
          <p className="mb-1 text-sm font-semibold">Recebedor no gateway (split)</p>
          <p className="mb-3 text-xs text-zinc-500">{f.pix_provider === 'efi' ? 'Efí: o split só funciona entre contas Efí. Informe o número da conta Efí do produtor e o CPF/CNPJ do titular.' : f.pix_provider === 'woovi' ? 'Woovi: a parte do produtor vai direto para a chave Pix dele. A Woovi precisa ter o Split habilitado na sua conta.' : 'Escolha o gateway para ver o que é necessário.'}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Conta / identificador no gateway"><Input value={f.recipient.account} onChange={(e) => setR('account', e.target.value)} placeholder="Nº da conta Efí ou id da subconta" /></Field>
            <Field label="Chave Pix"><Input value={f.recipient.pix_key} onChange={(e) => setR('pix_key', e.target.value)} /></Field>
            <Field label="CPF/CNPJ do titular"><Input value={f.recipient.document} onChange={(e) => setR('document', e.target.value)} /></Field>
            <Field label="Nome do titular"><Input value={f.recipient.name} onChange={(e) => setR('name', e.target.value)} /></Field>
            <Field label="Identificador de conta Efí (cartão)" hint="Para o repasse no cartão (payee_code)"><Input value={f.recipient.payee_code} onChange={(e) => setR('payee_code', e.target.value)} /></Field>
          </div>
        </div>
        <Switch checked={f.card_split_enabled} onChange={(v) => setF({ ...f, card_split_enabled: v })} label="Liberar cartão (Efí) com repasse para a conta Efí deste produtor" />
        <Switch checked={f.split_enabled} onChange={(v) => setF({ ...f, split_enabled: v })} label="Liberar vendas deste produtor (com split)" />
        <p className="text-xs text-zinc-500">Com as vendas liberadas, cada Pix deste produtor sai com split: a parte dele (venda − comissão) vai direto para o recebedor e a comissão fica na conta da Prime. Se o gateway recusar o split, o Pix não é gerado (o dinheiro dele nunca cai na sua conta).</p>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={save.isPending}>Salvar</Button>
        </div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ pedidos de cadastro
function Requests() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['team-requests'], queryFn: () => adminApi.get<Request[]>('/team/requests') });
  const act = useMutation({
    mutationFn: (v: { id: string; action: 'approve' | 'reject' }) => adminApi.post<{ message: string }>(`/team/requests/${v.id}/${v.action}`),
    onSuccess: (r) => (toast.ok(r.message), qc.invalidateQueries({ queryKey: ['team-requests'] }), qc.invalidateQueries({ queryKey: ['platform'] })),
    onError: (e) => toast.err(errMsg(e)),
  });
  if (q.isLoading) return <PageLoader />;
  return (
    <>
      {toast.node}
      {!q.data?.length ? (
        <Card><EmptyState icon={<UserPlus className="h-6 w-6" />} title="Nenhum pedido pendente" text="Quem clicar em “Criar cadastro” na tela de login aparece aqui para você aprovar como produtor." /></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="-m-5 divide-y divide-zinc-100">
            {q.data.map((r) => (
              <div key={r.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{r.name}{r.company ? ` · ${r.company}` : ''}</p>
                  <p className="text-xs text-zinc-500">{r.email}{r.phone ? ` · ${r.phone}` : ''} · {dateTime(r.created_at)}</p>
                  {r.message && <p className="mt-1 text-sm text-zinc-600">{r.message}</p>}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant="secondary" loading={act.isPending && act.variables?.id === r.id && act.variables.action === 'reject'} onClick={() => act.mutate({ id: r.id, action: 'reject' })}><X className="h-3.5 w-3.5" /> Recusar</Button>
                  <Button size="sm" loading={act.isPending && act.variables?.id === r.id && act.variables.action === 'approve'} onClick={() => act.mutate({ id: r.id, action: 'approve' })}><Check className="h-3.5 w-3.5" /> Aprovar produtor</Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

// ------------------------------------------------------------------ taxas
function Fees() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['platform', 'fees'], queryFn: () => adminApi.get<Policy[]>('/platform/fees') });
  const producers = useQuery({ queryKey: ['platform', 'producers'], queryFn: () => adminApi.get<Producer[]>('/platform/producers') });
  const current = q.data?.find((p) => !p.org_id);
  const [f, setF] = useState<{ org_id: string; fixed: string; percent: string; bump: string; gateway_fee_payer: string; refund_policy: string; note: string } | null>(null);
  const form = f ?? { org_id: '', fixed: centsToInput(current?.fixed_cents ?? 99), percent: String((current?.percent_bps ?? 0) / 100), bump: centsToInput(current?.bump_cents ?? 40), gateway_fee_payer: current?.gateway_fee_payer ?? 'producer', refund_policy: current?.refund_policy ?? 'keep_fee', note: '' };
  const set = (patch: Partial<typeof form>) => setF({ ...form, ...patch });
  const save = useMutation({
    mutationFn: () =>
      adminApi.post('/platform/fees', {
        org_id: form.org_id || null,
        fixed_cents: parseMoney(form.fixed),
        percent_bps: Math.round(Number(form.percent.replace(',', '.') || 0) * 100),
        bump_cents: parseMoney(form.bump),
        gateway_fee_payer: form.gateway_fee_payer,
        refund_policy: form.refund_policy,
        note: form.note || null,
      }),
    onSuccess: () => (toast.ok('Nova tabela de taxas salva. Vale para as próximas vendas; as antigas mantêm a taxa da época.'), setF(null), qc.invalidateQueries({ queryKey: ['platform', 'fees'] })),
    onError: (e) => toast.err(errMsg(e)),
  });
  if (q.isLoading) return <PageLoader />;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      {toast.node}
      <Card title="Nova tabela de taxas">
        <form className="space-y-4" onSubmit={(e) => (e.preventDefault(), save.mutate())}>
          <div className="flex items-start gap-2 rounded-xl bg-emerald-50 p-3 text-[13px] text-emerald-800"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" /> A conta proprietária (Prime) é sempre isenta: comissão R$ 0,00 em todas as vendas, definida no servidor.</div>
          <Field label="Vale para">
            <Select value={form.org_id} onChange={(e) => set({ org_id: e.target.value })}>
              <option value="">Todos os produtores (regra geral)</option>
              {(producers.data ?? []).filter((p) => !p.owner).map((p) => <option key={p.id} value={p.id}>Exceção: {p.name}</option>)}
            </Select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Por venda (R$)"><Input value={form.fixed} onChange={(e) => set({ fixed: e.target.value })} inputMode="decimal" /></Field>
            <Field label="Por order bump (R$)"><Input value={form.bump} onChange={(e) => set({ bump: e.target.value })} inputMode="decimal" /></Field>
            <Field label="Percentual (%)"><Input value={form.percent} onChange={(e) => set({ percent: e.target.value })} inputMode="decimal" /></Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Tarifa do gateway paga por">
              <Select value={form.gateway_fee_payer} onChange={(e) => set({ gateway_fee_payer: e.target.value })}>
                <option value="producer">Produtor</option>
                <option value="platform">Plataforma (Prime)</option>
              </Select>
            </Field>
            <Field label="Em reembolso, a comissão">
              <Select value={form.refund_policy} onChange={(e) => set({ refund_policy: e.target.value })}>
                <option value="keep_fee">Fica com a plataforma</option>
                <option value="refund_fee">É devolvida ao produtor</option>
              </Select>
            </Field>
          </div>
          <Field label="Observação (opcional)"><Input value={form.note} onChange={(e) => set({ note: e.target.value })} placeholder="Ex.: campanha de lançamento" /></Field>
          <Button type="submit" loading={save.isPending}>Salvar nova tabela</Button>
        </form>
      </Card>
      <Card title="Histórico (as vendas guardam a taxa da época)">
        <div className="-mx-5 -mb-5 divide-y divide-zinc-100">
          {(q.data ?? []).map((p) => (
            <div key={p.id} className="px-5 py-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{p.org_id ? `Exceção: ${p.org?.name ?? p.org_id}` : 'Regra geral'}</span>
                <span className="text-xs text-zinc-500">{dateTime(p.created_at)}</span>
              </div>
              <p className="text-zinc-600">{brl(p.fixed_cents)} por venda · {brl(p.bump_cents)} por bump{p.percent_bps ? ` · ${(p.percent_bps / 100).toLocaleString('pt-BR')}%` : ''}</p>
              {p.note && <p className="text-xs text-zinc-500">{p.note}</p>}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ financeiro global
function GlobalFinance() {
  const q = useQuery({ queryKey: ['platform', 'finance'], queryFn: () => adminApi.get<{ gross_cents: number; platform_fees_cents: number; refunds_cents: number; chargebacks_cents: number; sales: number; by_org: { org_id: string; name: string; owner: boolean; gross_cents: number; fees_cents: number; refunds_cents: number; sales: number }[]; by_gateway: { gateway: string; gross_cents: number }[] }>('/platform/finance') });
  if (q.isLoading || !q.data) return <PageLoader />;
  const d = q.data;
  const kpi = (label: string, v: string) => (
    <Card><p className="text-[13px] text-zinc-500">{label}</p><p className="pv mt-1 font-display text-[22px] font-bold">{v}</p></Card>
  );
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {kpi('Total transacionado (30 dias)', brl(d.gross_cents))}
        {kpi('Comissões da Prime', brl(d.platform_fees_cents))}
        {kpi('Reembolsos', brl(d.refunds_cents))}
        {kpi('Chargebacks', brl(d.chargebacks_cents))}
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card title="Por produtor">
          <div className="-mx-5 -mb-5 divide-y divide-zinc-100 text-sm">
            {d.by_org.map((o) => (
              <div key={o.org_id} className="flex items-center gap-3 px-5 py-3">
                <span className="min-w-0 flex-1 truncate font-medium">{o.name}{o.owner ? ' (proprietária)' : ''}</span>
                <span className="pv w-28 text-right tabular-nums">{brl(o.gross_cents)}</span>
                <span className="pv w-24 text-right tabular-nums text-blue-600">{brl(o.fees_cents)}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Por gateway">
          {d.by_gateway.map((g) => (
            <div key={g.gateway} className="flex items-center justify-between py-1.5 text-sm"><span>{g.gateway === 'efi' ? 'Efí Bank' : 'Woovi'}</span><span className="pv font-semibold">{brl(g.gross_cents)}</span></div>
          ))}
        </Card>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ auditoria
function Audit() {
  const q = useQuery({ queryKey: ['platform', 'audit'], queryFn: () => adminApi.get<{ id: string; actor_email: string | null; action: string; target: string | null; ip: string | null; created_at: string }[]>('/platform/audit') });
  if (q.isLoading) return <PageLoader />;
  return (
    <Card>
      {!q.data?.length ? (
        <p className="text-sm text-zinc-500">Nenhuma ação registrada ainda.</p>
      ) : (
        <div className="-m-5 divide-y divide-zinc-100 text-sm">
          {q.data.map((a) => (
            <div key={a.id} className="flex flex-col gap-0.5 px-5 py-3 sm:flex-row sm:items-center sm:gap-3">
              <span className="font-mono text-[12.5px] text-zinc-800">{a.action}</span>
              <span className="min-w-0 flex-1 truncate text-zinc-500">{a.target ?? ''}</span>
              <span className="text-xs text-zinc-500">{a.actor_email ?? '—'} · {dateTime(a.created_at)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
