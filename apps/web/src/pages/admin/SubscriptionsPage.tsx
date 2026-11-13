import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Repeat, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, cn, EmptyState, PageLoader, Select, useToast } from '@/components/ui';
import { adminApi, ApiError } from '@/lib/api';
import { brl, dateTime, productCode } from '@/lib/format';
import { PageHeader } from './AdminApp';

interface Sub {
  id: string;
  status: 'pending' | 'active' | 'past_due' | 'expired' | 'canceled';
  price_cents: number;
  items: { name: string }[];
  customer: { name: string; email: string; phone: string | null } | null;
  origin: { number: number; public_token: string } | null;
  rec_status: string | null;
  auto: boolean;
  paid_until: string | null;
  next_due: string | null;
  cobr_status: string | null;
  canceled_at: string | null;
  created_at: string;
  payments: number;
  received_cents: number;
  renew_url: string;
}

const statusText: Record<Sub['status'], string> = { pending: 'Aguardando 1º pagamento', active: 'Em dia', past_due: 'Vencida (tolerância)', expired: 'Pausada', canceled: 'Cancelada' };
const statusTone: Record<Sub['status'], string> = { pending: 'pending', active: 'active', past_due: 'past_due', expired: 'expired', canceled: 'canceled' };
const recText = (s: Sub) =>
  s.auto ? 'Débito automático autorizado' : s.rec_status === 'CRIADA' ? 'Autorização pendente no banco' : s.rec_status ? 'Sem débito automático (renova pelo link)' : 'Sem Pix Automático (renova pelo link)';

export default function SubscriptionsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState('all');
  const { data, isLoading, error } = useQuery({ queryKey: ['subscriptions', status], queryFn: () => adminApi.get<Sub[]>(`/subscriptions?status=${status}`) });
  const cancel = useMutation({
    mutationFn: (id: string) => adminApi.post<{ message: string }>(`/subscriptions/${id}/cancel`),
    onSuccess: (r) => (toast.ok(r.message), qc.invalidateQueries({ queryKey: ['subscriptions'] })),
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro'),
  });
  const list = data ?? [];
  const active = list.filter((s) => s.status === 'active' || s.status === 'past_due');
  const mrr = active.reduce((n, s) => n + s.price_cents, 0);

  return (
    <>
      <PageHeader title="Assinaturas" subtitle="Order bumps de assinatura mensal por Pix Automático. Ligue em Integrações e marque o bump em Order bumps." />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card><p className="text-xs text-gray-500">Ativas</p><p className="text-2xl font-bold tabular-nums">{active.length}</p></Card>
        <Card><p className="text-xs text-gray-500">Receita mensal recorrente</p><p className="pv text-2xl font-bold tabular-nums">{brl(mrr)}</p></Card>
        <Card><p className="text-xs text-gray-500">Com débito automático</p><p className="text-2xl font-bold tabular-nums">{active.filter((s) => s.auto).length}</p></Card>
        <Card>
          <p className="mb-1 text-xs text-gray-500">Mostrar</p>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="h-9 text-sm">
            <option value="all">Todas</option>
            <option value="active">Em dia</option>
            <option value="past_due">Vencidas (tolerância)</option>
            <option value="expired">Pausadas</option>
            <option value="pending">Aguardando 1º pagamento</option>
            <option value="canceled">Canceladas</option>
          </Select>
        </Card>
      </div>
      {isLoading ? (
        <PageLoader />
      ) : error ? (
        <Card><p className="text-sm text-amber-700">{error instanceof ApiError ? error.message : 'Erro ao carregar'}</p></Card>
      ) : !list.length ? (
        <Card><EmptyState icon={<Repeat className="h-6 w-6" />} title="Nenhuma assinatura" text="Quando alguém comprar um order bump de assinatura, ela aparece aqui." /></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="-m-5 divide-y divide-gray-100">
            {list.map((s) => (
              <div key={s.id} className="flex flex-col gap-3 px-5 py-4 lg:flex-row lg:items-center">
                <div className="min-w-0 flex-1">
                  <p className="pv truncate font-medium">{s.customer?.name ?? '—'} <span className="font-normal text-gray-500">· {s.customer?.email}</span></p>
                  <p className="truncate text-sm text-gray-600">{s.items.map((i) => i.name).join(' + ')} · <b className="pv">{brl(s.price_cents)}/mês</b></p>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {recText(s)}
                    {s.paid_until && <> · acesso pago até {new Date(s.paid_until).toLocaleDateString('pt-BR')}</>}
                    {s.payments > 0 && <> · {s.payments} pagamento{s.payments > 1 ? 's' : ''} ({<span className="pv">{brl(s.received_cents)}</span>})</>}
                    {s.origin && <> · <Link to="/admin/pedidos" className="text-blue-600 hover:underline">pedido ID: {productCode(s.origin.number)}</Link></>}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={statusTone[s.status]}>{statusText[s.status]}</Badge>
                  {s.status !== 'canceled' && s.status !== 'pending' && (
                    <Button size="sm" variant="ghost" aria-label="Copiar link de renovação" title="Copiar link de renovação (Pix)" onClick={() => navigator.clipboard?.writeText(s.renew_url).then(() => toast.ok('Link de renovação copiado'))}>
                      <Copy className="h-4 w-4" />
                    </Button>
                  )}
                  {s.status !== 'canceled' && (
                    <Button size="sm" variant="ghost" className={cn('text-red-600')} loading={cancel.isPending && cancel.variables === s.id} onClick={() => confirm('Cancelar esta assinatura? Os débitos param e o acesso segue até o fim do mês já pago.') && cancel.mutate(s.id)}>
                      <XCircle className="h-4 w-4" /> Cancelar
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
      <p className="mt-3 text-xs text-gray-500">Criada em: {list[0] ? dateTime(list[0].created_at) : '—'} (mais recente). O cliente também pode cancelar o Pix Automático no app do banco; o sistema detecta e passa a mandar o link de renovação.</p>
      {toast.node}
    </>
  );
}
