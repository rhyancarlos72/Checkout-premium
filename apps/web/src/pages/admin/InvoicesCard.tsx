import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, FileText, PlugZap, Receipt, Settings2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Card, cn, Field, Input, Modal, PageLoader, Switch } from '@/components/ui';
import { adminApi, ApiError } from '@/lib/api';
import { brl, centsToInput, dateTime, parseMoney, productCode } from '@/lib/format';

type Toast = { ok: (m: string) => void; err: (m: string) => void };

interface InvoiceSettings {
  enabled: boolean;
  type: 'service' | 'product';
  apiKey: string;
  apiKey_hint: string;
  has_apiKey: boolean;
  apiUrl: string;
  deductCents: number;
  sendEmailToCustomer: boolean;
  description: string;
  service: { federalServiceCode: string; cnaeCode: string; taxationInMunicipality: string; taxLocation: string; cityName: string; cityState: string };
  product: { operationNature: string; cfop: string; ncm: string; icmsCst: string; pisCst: string; cofinsCst: string; additionalInformation: string; street: string; number: string; district: string; postalCode: string; city: string; state: string };
}
interface InvoiceRow { order_id: string; type: string; status: string; number: string | null; message: string | null; amount_cents: number; updated_at: string; order: { number: number; customer: { name: string } | null } | null }

export const invoiceStatus: Record<string, { label: string; cls: string }> = {
  issued: { label: 'Emitida', cls: 'bg-emerald-50 text-emerald-700' },
  processing: { label: 'Processando', cls: 'bg-amber-50 text-amber-700' },
  error: { label: 'Erro', cls: 'bg-red-50 text-red-700' },
  canceled: { label: 'Cancelada', cls: 'bg-zinc-100 text-zinc-600' },
};

const SpedyLogo = () => (
  <span className="flex items-center gap-1.5 font-display leading-none">
    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#5b3df5] text-sm font-black text-white">S</span>
    <span className="text-[22px] font-extrabold tracking-tight text-[#5b3df5]">spedy</span>
  </span>
);

/** Integrações → Notas fiscais (Spedy): uma nota por venda, NFS-e ou NF-e, emitida no pagamento aprovado. */
export function InvoicesCard({ toast }: { toast: Toast }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['invoice-settings'], queryFn: () => adminApi.get<InvoiceSettings>('/integrations/invoices') });
  const list = useQuery({ queryKey: ['invoice-list'], queryFn: () => adminApi.get<InvoiceRow[]>('/integrations/invoices/list') });
  const [open, setOpen] = useState(false);
  const retry = useMutation({
    mutationFn: (orderId: string) => adminApi.post<{ ok: boolean; message: string }>(`/orders/${orderId}/invoice`),
    onSuccess: (r) => ((r.ok ? toast.ok : toast.err)(r.message), qc.invalidateQueries({ queryKey: ['invoice-list'] })),
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro ao reemitir'),
  });
  const [lastTest, setLastTest] = useState<{ ok: boolean; message: string; at: number } | null>(null);
  const test = useMutation({
    mutationFn: () => adminApi.post<{ ok: boolean; message: string }>('/integrations/invoices/test'),
    onSuccess: (r) => (setLastTest({ ...r, at: Date.now() }), (r.ok ? toast.ok : toast.err)(r.message)),
    onError: (e) => {
      const message = e instanceof ApiError ? e.message : 'Não foi possível testar agora';
      setLastTest({ ok: false, message, at: Date.now() });
      toast.err(message);
    },
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => adminApi.put('/integrations/invoices', { ...data, apiKey: '', enabled }),
    onSuccess: (_r, enabled) => (toast.ok(enabled ? 'Emissão automática ativada' : 'Emissão automática desativada'), qc.invalidateQueries({ queryKey: ['invoice-settings'] })),
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro'),
  });

  if (isLoading || !data) return <Card className="lg:col-span-2"><PageLoader /></Card>;
  const issued = (list.data ?? []).filter((i) => i.status === 'issued').length;
  const errors = (list.data ?? []).filter((i) => i.status === 'error').length;

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-6 lg:col-span-2">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <SpedyLogo />
          <h3 className="flex items-center gap-2 font-display text-lg font-semibold text-zinc-900"><Receipt className="h-5 w-5 text-[#5b3df5]" /> Notas fiscais</h3>
          <p className="max-w-xl text-sm text-zinc-500">Emite <b>uma nota por venda</b> assim que o Pix é aprovado, somando produto e order bumps num único valor. Escolha entre NFS-e (serviço) e NF-e (produto).</p>
        </div>
        <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
          {data.has_apiKey ? <span className="inline-flex items-center gap-1 text-sm font-medium text-emerald-600"><CheckCircle2 className="h-4 w-4" /> Conectado</span> : <span className="inline-flex items-center gap-1 text-sm font-medium text-zinc-500"><XCircle className="h-4 w-4" /> Não configurado</span>}
          <Switch checked={data.enabled} onChange={(v) => toggle.mutate(v)} label="Emitir no pagamento aprovado" />
        </div>
      </div>

      <div className="mt-5 grid gap-3 text-sm sm:grid-cols-4">
        <div className="rounded-xl border border-zinc-200 p-3"><p className="text-zinc-500">Tipo</p><p className="mt-0.5 font-semibold text-zinc-900">{data.type === 'product' ? 'NF-e · produto' : 'NFS-e · serviço'}</p></div>
        <div className="rounded-xl border border-zinc-200 p-3"><p className="text-zinc-500">Chave da API</p><p className="mt-0.5 font-mono font-semibold text-zinc-900">{data.apiKey_hint || '—'}</p></div>
        <div className="rounded-xl border border-zinc-200 p-3"><p className="text-zinc-500">Desconto na nota</p><p className="pv mt-0.5 font-semibold text-zinc-900">{brl(data.deductCents)}</p></div>
        <div className="rounded-xl border border-zinc-200 p-3"><p className="text-zinc-500">Últimas 30</p><p className="mt-0.5 font-semibold text-zinc-900">{issued} emitidas{errors ? <span className="text-red-600"> · {errors} com erro</span> : ''}</p></div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={() => setOpen(true)}><Settings2 className="h-4 w-4" /> Configurar</Button>
        <Button variant="secondary" disabled={!data.has_apiKey} loading={test.isPending} onClick={() => test.mutate()}><PlugZap className="h-4 w-4" /> {test.isPending ? 'Testando…' : 'Testar conexão'}</Button>
      </div>
      {!data.has_apiKey && <p className="mt-2 text-xs text-zinc-500">Salve a chave da API em <b>Configurar</b> para liberar o teste.</p>}
      {lastTest && (
        <p className={cn('mt-3 flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm', lastTest.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700')}>
          {lastTest.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
          <span><b>{lastTest.ok ? 'Funcionou:' : 'Falhou:'}</b> {lastTest.message} <span className="opacity-60">· {new Date(lastTest.at).toLocaleTimeString('pt-BR')}</span></span>
        </p>
      )}

      {(list.data?.length ?? 0) > 0 && (
        <div className="mt-5 overflow-hidden rounded-xl border border-zinc-200">
          <p className="border-b border-zinc-100 bg-zinc-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Últimas notas</p>
          <ul className="divide-y divide-zinc-100 text-sm">
            {list.data!.slice(0, 8).map((i) => (
              <li key={i.order_id} className="flex items-center gap-3 px-4 py-2.5">
                <FileText className="h-4 w-4 shrink-0 text-zinc-400" />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium text-zinc-900">Pedido ID: {i.order ? productCode(i.order.number) : '—'}</span>
                  <span className="pv text-zinc-500"> · {i.order?.customer?.name ?? ''}{i.number ? ` · nº ${i.number}` : ''}</span>
                  {i.status === 'error' && i.message && <span className="block truncate text-xs text-red-600">{i.message}</span>}
                </span>
                <span className="pv tabular-nums text-zinc-700">{brl(i.amount_cents)}</span>
                <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', invoiceStatus[i.status]?.cls)}>{invoiceStatus[i.status]?.label ?? i.status}</span>
                {i.status === 'error' && (
                  <button type="button" disabled={retry.isPending} onClick={() => retry.mutate(i.order_id)} className="shrink-0 rounded-lg border border-zinc-200 px-2 py-1 text-xs font-semibold text-blue-600 hover:bg-blue-50 disabled:opacity-50">
                    {retry.isPending && retry.variables === i.order_id ? 'Enviando…' : 'Tentar de novo'}
                  </button>
                )}
                <span className="hidden text-xs text-zinc-400 sm:block">{dateTime(i.updated_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {open && <InvoicesModal data={data} toast={toast} onClose={() => setOpen(false)} onSaved={() => (qc.invalidateQueries({ queryKey: ['invoice-settings'] }), setOpen(false))} />}
    </section>
  );
}

function InvoicesModal({ data, toast, onClose, onSaved }: { data: InvoiceSettings; toast: Toast; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<InvoiceSettings>({ ...data, apiKey: '' });
  const [deduct, setDeduct] = useState(centsToInput(data.deductCents));
  useEffect(() => setF({ ...data, apiKey: '' }), [data]);
  const set = (p: Partial<InvoiceSettings>) => setF((x) => ({ ...x, ...p }));
  const setS = (p: Partial<InvoiceSettings['service']>) => setF((x) => ({ ...x, service: { ...x.service, ...p } }));
  const setP = (p: Partial<InvoiceSettings['product']>) => setF((x) => ({ ...x, product: { ...x.product, ...p } }));
  const [modalTest, setModalTest] = useState<{ ok: boolean; message: string } | null>(null);
  const testNow = useMutation({
    mutationFn: () => adminApi.post<{ ok: boolean; message: string }>('/integrations/invoices/test', { apiKey: f.apiKey, type: f.type, apiUrl: f.apiUrl }),
    onSuccess: (r) => setModalTest(r),
    onError: (e) => setModalTest({ ok: false, message: e instanceof ApiError ? e.message : 'Não foi possível testar agora' }),
  });
  const save = useMutation({
    mutationFn: () => {
      const { apiKey_hint: _h, has_apiKey: _k, ...rest } = f;
      return adminApi.put('/integrations/invoices', { ...rest, deductCents: deduct.trim() ? parseMoney(deduct) : 0 });
    },
    onSuccess: () => (toast.ok('Configuração da Spedy salva'), onSaved()),
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro ao salvar'),
  });

  return (
    <Modal open onClose={onClose} title="Notas fiscais · Spedy" wide>
      <div className="space-y-5">
        <Field label="Chave da API Spedy (X-Api-Key)" hint={data.has_apiKey ? `Salva: ${data.apiKey_hint}. Deixe em branco para manter.` : 'Spedy → Configurações → Integrações → API.'}>
          <Input type="password" autoComplete="off" value={f.apiKey} onChange={(e) => set({ apiKey: e.target.value })} placeholder={data.has_apiKey ? '••••••••' : 'cole a chave aqui'} className="font-mono text-sm" />
        </Field>

        <div>
          <p className="mb-2 text-sm font-medium text-zinc-700">Tipo de nota</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {([
              ['service', 'NFS-e · Nota de serviço', 'Emitida pela prefeitura. Comum para infoprodutos e cursos.'],
              ['product', 'NF-e · Nota de produto', 'Emitida pela SEFAZ. Use se você vende como mercadoria.'],
            ] as const).map(([v, t, d]) => (
              <button key={v} type="button" onClick={() => set({ type: v })} className={cn('rounded-xl border-2 p-4 text-left transition', f.type === v ? 'border-blue-600 bg-blue-50/60' : 'border-zinc-200 hover:border-zinc-300')}>
                <p className="font-semibold text-zinc-900">{t}</p>
                <p className="mt-1 text-xs text-zinc-500">{d}</p>
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Descontar do valor da nota (R$)" hint="Ex.: 0,50 da taxa do Pix. Use 0 para o valor cheio."><Input value={deduct} onChange={(e) => setDeduct(e.target.value)} inputMode="decimal" placeholder="0,50" /></Field>
          <Field label="Texto complementar da descrição"><Input value={f.description} onChange={(e) => set({ description: e.target.value })} /></Field>
        </div>
        <Switch checked={f.sendEmailToCustomer} onChange={(v) => set({ sendEmailToCustomer: v })} label="A Spedy envia a nota por e-mail ao cliente" />

        {f.type === 'service' ? (
          <div className="space-y-4 rounded-xl border border-zinc-200 p-4">
            <p className="text-sm font-semibold text-zinc-800">Dados da NFS-e</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Código do serviço (LC 116)"><Input value={f.service.federalServiceCode} onChange={(e) => setS({ federalServiceCode: e.target.value })} /></Field>
              <Field label="CNAE"><Input value={f.service.cnaeCode} onChange={(e) => setS({ cnaeCode: e.target.value })} /></Field>
              <Field label="Tributação no município" hint="nonIncidence = não incidência"><Input value={f.service.taxationInMunicipality} onChange={(e) => setS({ taxationInMunicipality: e.target.value })} /></Field>
              <Field label="Local da tributação"><Input value={f.service.taxLocation} onChange={(e) => setS({ taxLocation: e.target.value })} /></Field>
              <Field label="Município da prestação"><Input value={f.service.cityName} onChange={(e) => setS({ cityName: e.target.value })} placeholder="Ex.: Alcântaras" /></Field>
              <Field label="UF"><Input value={f.service.cityState} maxLength={2} onChange={(e) => setS({ cityState: e.target.value.toUpperCase() })} placeholder="CE" /></Field>
            </div>
          </div>
        ) : (
          <div className="space-y-4 rounded-xl border border-zinc-200 p-4">
            <p className="text-sm font-semibold text-zinc-800">Dados da NF-e</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Natureza da operação"><Input value={f.product.operationNature} onChange={(e) => setP({ operationNature: e.target.value })} /></Field>
              <Field label="CFOP"><Input value={f.product.cfop} onChange={(e) => setP({ cfop: e.target.value })} /></Field>
              <Field label="NCM"><Input value={f.product.ncm} onChange={(e) => setP({ ncm: e.target.value })} /></Field>
              <Field label="CST ICMS (CSOSN)"><Input value={f.product.icmsCst} onChange={(e) => setP({ icmsCst: e.target.value })} /></Field>
              <Field label="CST PIS"><Input value={f.product.pisCst} onChange={(e) => setP({ pisCst: e.target.value })} /></Field>
              <Field label="CST COFINS"><Input value={f.product.cofinsCst} onChange={(e) => setP({ cofinsCst: e.target.value })} /></Field>
            </div>
            <Field label="Informações adicionais"><Input value={f.product.additionalInformation} onChange={(e) => setP({ additionalInformation: e.target.value })} /></Field>
            <p className="text-xs text-zinc-500">Endereço padrão do comprador (o checkout não pede endereço):</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Rua"><Input value={f.product.street} onChange={(e) => setP({ street: e.target.value })} /></Field>
              <Field label="Número"><Input value={f.product.number} onChange={(e) => setP({ number: e.target.value })} /></Field>
              <Field label="Bairro"><Input value={f.product.district} onChange={(e) => setP({ district: e.target.value })} /></Field>
              <Field label="CEP"><Input value={f.product.postalCode} onChange={(e) => setP({ postalCode: e.target.value })} /></Field>
              <Field label="Cidade"><Input value={f.product.city} onChange={(e) => setP({ city: e.target.value })} /></Field>
              <Field label="UF"><Input value={f.product.state} maxLength={2} onChange={(e) => setP({ state: e.target.value.toUpperCase() })} /></Field>
            </div>
          </div>
        )}
        <p className="rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-800">Confira códigos e tributação com seu contador. Os valores padrão vieram do sistema antigo.</p>
        {modalTest && (
          <p className={cn('flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm', modalTest.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700')}>
            {modalTest.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
            <span><b>{modalTest.ok ? 'Funcionou:' : 'Falhou:'}</b> {modalTest.message}</span>
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" loading={testNow.isPending} disabled={!f.apiKey && !data.has_apiKey} onClick={() => testNow.mutate()}><PlugZap className="h-4 w-4" /> Testar esta chave</Button>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>Salvar</Button>
        </div>
      </div>
    </Modal>
  );
}
