import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download, RefreshCw, Search, Send, ShoppingBag, Undo2, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, cn, EmptyState, Input, Modal, PageLoader, Select, StatusBadge, useToast } from '@/components/ui';
import { adminApi, ApiError } from '@/lib/api';
import { brl, dateTime } from '@/lib/format';
import { PageHeader } from './AdminApp';

interface OrderRow {
  id: string;
  number: number;
  status: string;
  provider: string;
  total_cents: number;
  created_at: string;
  paid_at: string | null;
  tracking: Record<string, string>;
  customer: { name: string; email: string; phone: string | null } | null;
  checkout: { name: string; slug: string } | null;
  items: { kind: string; name: string; price_cents: number }[];
}

export function useDebounced<T>(v: T, ms = 350) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export default function OrdersPage() {
  const [status, setStatus] = useState('all');
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
          <option value="all">Todos os status</option><option value="paid">Pagos</option><option value="pending">Pendentes</option><option value="expired">Expirados</option><option value="refunded">Reembolsados</option><option value="failed">Falhos</option>
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
                    <td className="px-5 py-3"><p className="font-semibold">#{o.number}</p><p className="text-xs text-gray-500">{dateTime(o.created_at)}</p></td>
                    <td className="px-5 py-3"><p className="font-medium">{o.customer?.name ?? '—'}</p><p className="text-xs text-gray-500">{o.customer?.email}</p></td>
                    <td className="px-5 py-3 text-gray-600">{o.items.find((i) => i.kind === 'main')?.name}{o.items.some((i) => i.kind === 'bump') && <span className="ml-1 inline-flex items-center gap-0.5 text-xs text-teal-700"><Zap className="h-3 w-3" />+{o.items.filter((i) => i.kind === 'bump').length}</span>}</td>
                    <td className="px-5 py-3 text-xs text-gray-500">{o.tracking?.utm_source ?? 'direto'}{o.tracking?.utm_campaign ? ` / ${o.tracking.utm_campaign}` : ''}</td>
                    <td className="px-5 py-3 text-right font-semibold tabular-nums">{brl(o.total_cents)}</td>
                    <td className="px-5 py-3"><StatusBadge status={o.status} /></td>
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

function OrderDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: o, isLoading } = useQuery({ queryKey: ['order', id], queryFn: () => adminApi.get<any>(`/orders/${id}`) });
  const action = useMutation({
    mutationFn: (a: string) => adminApi.post<any>(`/orders/${id}/${a}`),
    onSuccess: (r, a) => {
      qc.invalidateQueries({ queryKey: ['order', id] });
      qc.invalidateQueries({ queryKey: ['orders'] });
      toast.ok(a === 'sync' ? `Consulta ao gateway: ${r.result}` : 'Feito');
    },
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro'),
  });

  return (
    <Modal open onClose={onClose} title={o ? `Pedido #${o.number}` : 'Pedido'} wide>
      {isLoading || !o ? (
        <PageLoader />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={o.status} />
            <Badge tone="off">{o.provider === 'efi' ? 'Efí' : 'Woovi'}</Badge>
            <span className="text-sm text-gray-500">Criado {dateTime(o.created_at)}{o.paid_at && ` · Pago ${dateTime(o.paid_at)}`}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {o.status !== 'paid' && <Button size="sm" variant="secondary" loading={action.isPending && action.variables === 'sync'} onClick={() => action.mutate('sync')}><RefreshCw className="h-3.5 w-3.5" /> Consultar gateway</Button>}
            {o.status === 'paid' && <Button size="sm" variant="secondary" loading={action.isPending && action.variables === 'resend-delivery'} onClick={() => action.mutate('resend-delivery')}><Send className="h-3.5 w-3.5" /> Reenviar acesso</Button>}
            <Button size="sm" variant="secondary" loading={action.isPending && action.variables === 'resend-tracking'} onClick={() => action.mutate('resend-tracking')}><Zap className="h-3.5 w-3.5" /> Reenviar ao PayTracking</Button>
            {o.status === 'paid' && <Button size="sm" variant="ghost" onClick={() => confirm('Marcar como reembolsado? Faça o estorno do PIX no painel do gateway.') && action.mutate('refund')}><Undo2 className="h-3.5 w-3.5" /> Marcar reembolso</Button>}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-gray-200 p-4 text-sm">
              <p className="mb-2 font-semibold">Cliente</p>
              <p>{o.customer?.name}</p><p className="text-gray-600">{o.customer?.email}</p><p className="text-gray-600">{o.customer?.phone}</p>
              {o.customer?.document && <p className="text-gray-600">Doc: ***{String(o.customer.document).slice(-4)}</p>}
            </div>
            <div className="rounded-xl border border-gray-200 p-4 text-sm">
              <p className="mb-2 font-semibold">Itens</p>
              {o.items.map((i: any) => <div key={i.id} className="flex justify-between gap-2"><span>{i.kind === 'bump' && '⚡ '}{i.name}</span><span className="tabular-nums">{brl(i.price_cents)}</span></div>)}
              {o.discount_cents > 0 && <div className="flex justify-between text-emerald-700"><span>Desconto {o.coupon?.code && `(${o.coupon.code})`}</span><span>−{brl(o.discount_cents)}</span></div>}
              <div className="mt-1 flex justify-between border-t border-gray-100 pt-1 font-semibold"><span>Total</span><span>{brl(o.total_cents)}</span></div>
            </div>
          </div>
          <div className="rounded-xl border border-gray-200 p-4 text-sm">
            <p className="mb-2 font-semibold">Rastreamento</p>
            <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
              {Object.entries(o.tracking ?? {}).filter(([k]) => !['session_id'].includes(k)).map(([k, v]) => <div key={k} className="truncate"><span className="text-gray-500">{k}:</span> <span className="font-mono text-xs">{String(v)}</span></div>)}
              <div className="truncate"><span className="text-gray-500">ip:</span> <span className="font-mono text-xs">{o.ip}</span></div>
            </div>
          </div>
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
