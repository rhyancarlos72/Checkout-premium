import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, CreditCard, Download, Trash2, MailCheck, MailPlus, Receipt, RefreshCw, Search, Send, ShoppingBag, Undo2, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, cn, EmptyState, Input, Modal, PageLoader, Select, StatusBadge, useToast } from '@/components/ui';
import { adminApi, ApiError } from '@/lib/api';
import { brl, dateTime, productCode } from '@/lib/format';
import { PageHeader } from './AdminApp';
import { useMe } from '@/lib/me';
import { invoiceStatus } from './InvoicesCard';

interface OrderRow {
  id: string;
  number: number;
  status: string;
  provider: string;
  payment_method?: 'pix' | 'card' | null;
  total_cents: number;
  created_at: string;
  paid_at: string | null;
  recovery_sent_at?: string | null;
  tracking: Record<string, string>;
  customer: { name: string; email: string; phone: string | null } | null;
  checkout: { name: string; slug: string } | null;
  items: { kind: string; name: string; price_cents: number; product?: { number: number | null } | null }[];
}

/** Forma de pagamento ao lado do status: Pix ou Cartão (pedidos antigos, sem a informação, são Pix). */
export function MethodBadge({ method }: { method?: string | null }) {
  const card = method === 'card';
  return (
    <span title={card ? 'Pago com cartão de crédito' : 'Pago com Pix'} className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold', card ? 'bg-indigo-50 text-indigo-700' : 'bg-teal-50 text-teal-700')}>
      {card ? <CreditCard className="h-3 w-3" /> : <PixIcon className="h-3 w-3" />}
      {card ? 'Cartão' : 'Pix'}
    </span>
  );
}
function PixIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className={className}>
      <path d="M11.9 11.6a2.3 2.3 0 0 1-1.6-.7L8 8.6a.4.4 0 0 0-.6 0L5.1 10.9a2.3 2.3 0 0 1-1.6.7H3l2.9 2.9a2.3 2.3 0 0 0 3.3 0l2.9-2.9h-.2ZM3.5 4.4c.6 0 1.2.2 1.6.7l2.3 2.3c.2.2.5.2.6 0l2.3-2.3c.4-.4 1-.7 1.6-.7h.3L9.3 1.5a2.3 2.3 0 0 0-3.3 0L3.2 4.4h.3Z" />
      <path d="m14.5 6.3-1.7-1.7h-.9c-.4 0-.8.2-1.1.5L8.5 7.4a1 1 0 0 1-1.4 0L4.8 5.1c-.3-.3-.7-.5-1.1-.5H2.6L.9 6.3a2.3 2.3 0 0 0 0 3.3l1.7 1.7h1.1c.4 0 .8-.2 1.1-.5l2.3-2.3a1 1 0 0 1 1.4 0l2.3 2.3c.3.3.7.5 1.1.5h.9l1.7-1.7a2.3 2.3 0 0 0 0-3.3Z" />
    </svg>
  );
}

export function useDebounced<T>(v: T, ms = 350) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

/** Lixeira: exclui a cobrança (ex.: testes) para não bagunçar vendas e conversão. Só o dono. */
function DeleteOrderButton({ order, onDeleted, label }: { order: OrderRow | { id: string; number: number; status: string; total_cents: number; customer?: { name?: string } | null }; onDeleted?: () => void; label?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const del = useMutation({
    mutationFn: () => adminApi.del(`/orders/${order.id}`),
    onSuccess: () => {
      toast.ok('Cobrança excluída');
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.invalidateQueries({ queryKey: ['progress'] });
      onDeleted?.();
    },
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro ao excluir'),
  });
  const ask = (e: React.MouseEvent) => {
    e.stopPropagation();
    const paid = order.status === 'paid' ? '\n\nATENÇÃO: esta venda está PAGA. Ela sairá do faturamento e dos relatórios.' : '';
    if (confirm(`Excluir a cobrança ID ${productCode(order.number)} (${brl(order.total_cents)}${order.customer?.name ? ` · ${order.customer.name}` : ''})?\n\nEla some de Vendas, do dashboard e da conversão. Não dá para desfazer.${paid}`)) del.mutate();
  };
  return (
    <>
      {label ? (
        <Button size="sm" variant="ghost" loading={del.isPending} onClick={ask} className="text-red-600 hover:bg-red-50"><Trash2 className="h-3.5 w-3.5" /> Excluir cobrança</Button>
      ) : (
        <button type="button" title="Excluir cobrança" aria-label="Excluir cobrança" disabled={del.isPending} onClick={ask} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-transparent text-zinc-400 transition hover:border-red-500/30 hover:bg-red-50 hover:text-red-600 disabled:opacity-50">
          {del.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        </button>
      )}
      {toast.node}
    </>
  );
}

export default function OrdersPage() {
  const isOwner = useMe().data?.role === 'owner';
  const [status, setStatus] = useState(() => new URLSearchParams(window.location.search).get('status') || 'all');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const dq = useDebounced(q);
  const params = new URLSearchParams({ status, page: String(page), ...(dq && { q: dq }) });
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['orders', status, dq, page],
    queryFn: () => adminApi.get<{ data: OrderRow[]; total: number; pageSize: number }>(`/orders?${params}`),
    placeholderData: keepPreviousData,
  });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <PageHeader
        title="Pedidos"
        subtitle={data ? `${data.total} pedidos` : undefined}
        action={<Button variant="secondary" onClick={() => adminApi.download(`/orders/export.csv?${new URLSearchParams({ status, ...(dq && { q: dq }) })}`, 'pedidos.csv')}><Download className="h-4 w-4" /> Exportar CSV</Button>}
      />
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="flex-1"><Input icon={<Search className="h-4 w-4" />} placeholder="Buscar por nº do pedido, nome ou e-mail" value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} /></div>
        <Select className="sm:w-48" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
          <option value="all">Todos os status</option><option value="paid">Pagos</option><option value="pending">Pendentes</option><option value="refunded">Reembolsados</option><option value="failed">Falhos</option>
        </Select>
      </div>
      {isLoading ? (
        <PageLoader />
      ) : !data?.data.length ? (
        <Card><EmptyState icon={<ShoppingBag className="h-6 w-6" />} title="Nenhum pedido encontrado" /></Card>
      ) : (
        <Card className={cn(isFetching && 'opacity-70')}>
          <div className="-m-5 overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b border-gray-100 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr><th className="px-5 py-3 font-medium">Pedido</th><th className="px-5 py-3 font-medium">Cliente</th><th className="px-5 py-3 font-medium">Itens</th><th className="px-5 py-3 font-medium">Origem</th><th className="px-5 py-3 text-right font-medium">Total</th><th className="px-5 py-3 font-medium">Status</th></tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.data.map((o) => (
                  <tr key={o.id} className="cursor-pointer hover:bg-gray-50" onClick={() => setOpen(o.id)}>
                    <td className="px-5 py-3"><p className="font-semibold">ID: {productCode(o.number)}</p><p className="text-xs text-gray-500">{dateTime(o.created_at)}</p></td>
                    <td className="px-5 py-3"><p className="pv font-medium">{o.customer?.name ?? '—'}</p><p className="pv text-xs text-gray-500">{o.customer?.email}</p></td>
                    <td className="px-5 py-3 text-gray-600">{(() => { const m = o.items.find((i) => i.kind === 'main'); return m ? <span className="pv">{m.product?.number && <span className="mr-1.5 rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-zinc-600">ID: {productCode(m.product.number)}</span>}{m.name}</span> : null; })()}{o.items.some((i) => i.kind === 'bump') && <span className="ml-1 inline-flex items-center gap-0.5 text-xs text-teal-700"><Zap className="h-3 w-3" />+{o.items.filter((i) => i.kind === 'bump').length}</span>}</td>
                    <td className="px-5 py-3 text-xs text-gray-500">{o.tracking?.utm_source ?? 'direto'}{o.tracking?.utm_campaign ? ` / ${o.tracking.utm_campaign}` : ''}</td>
                    <td className="pv px-5 py-3 text-right font-semibold tabular-nums">{brl(o.total_cents)}</td>
                    <td className="px-5 py-3"><div className="flex items-center gap-2"><StatusBadge status={o.status} /><MethodBadge method={o.payment_method} />{(o.status === 'pending' || o.status === 'expired') && <RecoveryEmailButton order={o} />}{isOwner && <DeleteOrderButton order={o} />}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {pages > 1 && (
        <div className="mt-4 flex items-center justify-end gap-2 text-sm">
          <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Anterior"><ChevronLeft className="h-4 w-4" /></Button>
          <span className="text-gray-600">Página {page} de {pages}</span>
          <Button size="sm" variant="secondary" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Próxima"><ChevronRight className="h-4 w-4" /></Button>
        </div>
      )}
      {open && <OrderDetail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/** Ícone ao lado do status: envia na hora o e-mail de recuperação para o cliente do pedido pendente. */
function RecoveryEmailButton({ order }: { order: OrderRow }) {
  const qc = useQueryClient();
  const toast = useToast();
  const send = useMutation({
    mutationFn: () => adminApi.post<{ ok: boolean; message: string }>(`/orders/${order.id}/recovery-email`),
    onSuccess: (r) => {
      (r.ok ? toast.ok : toast.err)(r.message);
      if (r.ok) qc.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro ao enviar'),
  });
  const sent = Boolean(order.recovery_sent_at);
  const title = sent ? `Recuperação enviada em ${dateTime(order.recovery_sent_at!)}. Clique para enviar de novo` : `Enviar e-mail de recuperação para ${order.customer?.email ?? 'o cliente'}`;
  return (
    <>
      <button
        type="button"
        title={title}
        aria-label={title}
        disabled={send.isPending}
        onClick={(e) => {
          e.stopPropagation();
          if (sent && !confirm(`Este cliente já recebeu a recuperação em ${dateTime(order.recovery_sent_at!)}. Enviar de novo?`)) return;
          send.mutate();
        }}
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition disabled:opacity-60',
          sent ? 'border-emerald-500/30 bg-emerald-50 text-emerald-700 hover:bg-emerald-100' : 'border-blue-500/30 bg-blue-50 text-blue-600 hover:bg-blue-500/20',
        )}
      >
        {send.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : sent ? <MailCheck className="h-4 w-4" /> : <MailPlus className="h-4 w-4" />}
      </button>
      {toast.node}
    </>
  );
}

function OrderDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const isOwner = useMe().data?.role === 'owner';
  const qc = useQueryClient();
  const toast = useToast();
  const { data: o, isLoading } = useQuery({ queryKey: ['order', id], queryFn: () => adminApi.get<any>(`/orders/${id}`) });
  const action = useMutation({
    mutationFn: (a: string) => adminApi.post<any>(`/orders/${id}/${a}`),
    onSuccess: (r, a) => {
      qc.invalidateQueries({ queryKey: ['order', id] });
      qc.invalidateQueries({ queryKey: ['orders'] });
      if (a.startsWith('invoice')) return (r?.ok === false ? toast.err : toast.ok)(r?.message ?? 'Feito');
      toast.ok(a === 'sync' ? `Consulta ao gateway: ${r.result}` : 'Feito');
    },
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro'),
  });

  return (
    <Modal open onClose={onClose} title={o ? `Pedido ID: ${productCode(o.number)}` : 'Pedido'} wide>
      {isLoading || !o ? (
        <PageLoader />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={o.status} />
            <MethodBadge method={o.payment_method} />
            <Badge tone="off">{o.provider === 'efi' ? 'Efí' : 'Woovi'}</Badge>
            <span className="text-sm text-gray-500">Criado {dateTime(o.created_at)}{o.paid_at && ` · Pago ${dateTime(o.paid_at)}`}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {o.status !== 'paid' && <Button size="sm" variant="secondary" loading={action.isPending && action.variables === 'sync'} onClick={() => action.mutate('sync')}><RefreshCw className="h-3.5 w-3.5" /> Consultar gateway</Button>}
            {o.status === 'paid' && <Button size="sm" variant="secondary" loading={action.isPending && action.variables === 'resend-delivery'} onClick={() => action.mutate('resend-delivery')}><Send className="h-3.5 w-3.5" /> Reenviar acesso</Button>}
            <Button size="sm" variant="secondary" loading={action.isPending && action.variables === 'resend-tracking'} onClick={() => action.mutate('resend-tracking')}><Zap className="h-3.5 w-3.5" /> Reenviar ao PayTracking</Button>
            {o.status === 'paid' && <Button size="sm" variant="ghost" onClick={() => confirm(`Marcar como reembolsado? Faça o estorno ${o.payment_method === 'card' ? 'do cartão' : 'do Pix'} no painel do gateway.`) && action.mutate('refund')}><Undo2 className="h-3.5 w-3.5" /> Marcar reembolso</Button>}
            {isOwner && <DeleteOrderButton order={o} label onDeleted={onClose} />}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-gray-200 p-4 text-sm">
              <p className="mb-2 font-semibold">Cliente</p>
              <p className="pv">{o.customer?.name}</p><p className="pv text-gray-600">{o.customer?.email}</p><p className="pv text-gray-600">{o.customer?.phone}</p>
              {o.customer?.document && <p className="text-gray-600">Doc: ***{String(o.customer.document).slice(-4)}</p>}
            </div>
            <div className="rounded-xl border border-gray-200 p-4 text-sm">
              <p className="mb-2 font-semibold">Itens</p>
              {o.items.map((i: any) => <div key={i.id} className="flex justify-between gap-2"><span className="pv">{i.kind === 'bump' && '⚡ '}{i.product?.number && <span className="mr-1 font-mono text-xs text-zinc-500">ID: {productCode(i.product.number)}</span>}{i.name}</span><span className="pv tabular-nums">{brl(i.price_cents)}</span></div>)}
              {o.discount_cents > 0 && <div className="flex justify-between text-emerald-700"><span>Desconto {o.coupon?.code && `(${o.coupon.code})`}</span><span className="pv">−{brl(o.discount_cents)}</span></div>}
              <div className="mt-1 flex justify-between border-t border-gray-100 pt-1 font-semibold"><span>Total</span><span className="pv">{brl(o.total_cents)}</span></div>
            </div>
          </div>
          <div className="rounded-xl border border-gray-200 p-4 text-sm">
            <p className="mb-2 font-semibold">Rastreamento</p>
            <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
              {Object.entries(o.tracking ?? {}).filter(([k]) => !['session_id'].includes(k)).map(([k, v]) => <div key={k} className="truncate"><span className="text-gray-500">{k}:</span> <span className="font-mono text-xs">{String(v)}</span></div>)}
              <div className="truncate"><span className="text-gray-500">ip:</span> <span className="font-mono text-xs">{o.ip}</span></div>
            </div>
          </div>
          {o.status === 'paid' && (
            <div className="rounded-xl border border-gray-200 p-4 text-sm">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="flex items-center gap-2 font-semibold"><Receipt className="h-4 w-4 text-zinc-500" /> Nota fiscal</p>
                {o.invoice && <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', invoiceStatus[o.invoice.status]?.cls)}>{invoiceStatus[o.invoice.status]?.label ?? o.invoice.status}</span>}
              </div>
              {o.invoice ? (
                <div className="space-y-2">
                  <p className="pv text-gray-600">{o.invoice.type === 'product' ? 'NF-e (produto)' : 'NFS-e (serviço)'} · {brl(o.invoice.amount_cents)}{o.invoice.number && ` · nº ${o.invoice.number}`} · {dateTime(o.invoice.updated_at)}</p>
                  {o.invoice.message && <p className={cn('rounded-lg p-2 text-xs', o.invoice.status === 'error' ? 'bg-red-50 text-red-700' : 'bg-zinc-50 text-zinc-600')}>{o.invoice.message}</p>}
                  <div className="flex flex-wrap gap-2">
                    {o.invoice.status === 'error' && <Button size="sm" variant="secondary" loading={action.isPending && action.variables === 'invoice'} onClick={() => action.mutate('invoice')}><RefreshCw className="h-3.5 w-3.5" /> Tentar emitir de novo</Button>}
                    {o.invoice.provider_id && o.invoice.status !== 'error' && <Button size="sm" variant="secondary" loading={action.isPending && action.variables === 'invoice/refresh'} onClick={() => action.mutate('invoice/refresh')}><RefreshCw className="h-3.5 w-3.5" /> Atualizar status</Button>}
                    {o.invoice.status === 'issued' && <>
                      <Button size="sm" variant="ghost" onClick={() => adminApi.download(`/orders/${id}/invoice/pdf`, `nota-${productCode(o.number)}.pdf`).catch(() => toast.err('PDF ainda não disponível'))}><Download className="h-3.5 w-3.5" /> PDF</Button>
                      <Button size="sm" variant="ghost" onClick={() => adminApi.download(`/orders/${id}/invoice/xml`, `nota-${productCode(o.number)}.xml`).catch(() => toast.err('XML ainda não disponível'))}><Download className="h-3.5 w-3.5" /> XML</Button>
                    </>}
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-gray-500">Nenhuma nota emitida para esta venda.</p>
                  <Button size="sm" variant="secondary" loading={action.isPending && action.variables === 'invoice'} onClick={() => action.mutate('invoice')}><Receipt className="h-3.5 w-3.5" /> Emitir nota agora</Button>
                </div>
              )}
            </div>
          )}
          {o.error && <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{o.error}</p>}
          <div className="rounded-xl border border-gray-200 p-4 text-sm">
            <p className="mb-2 font-semibold">Histórico de integrações</p>
            {o.logs.length === 0 ? <p className="text-gray-500">Nenhum envio registrado.</p> : (
              <ul className="space-y-1.5">
                {o.logs.map((l: any) => <li key={l.id} className="flex items-center gap-2"><span className={cn('h-2 w-2 rounded-full', l.ok ? 'bg-emerald-500' : 'bg-red-500')} /><span className="font-medium">{l.integration}</span><span className="text-gray-500">{l.event}</span><span className="flex-1 truncate text-gray-500">{l.message}</span><span className="text-xs text-gray-400">{dateTime(l.created_at)}</span></li>)}
              </ul>
            )}
          </div>
        </div>
      )}
      {toast.node}
    </Modal>
  );
}
