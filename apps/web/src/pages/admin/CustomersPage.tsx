import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Search, Users } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, EmptyState, Input, PageLoader } from '@/components/ui';
import { adminApi } from '@/lib/api';
import { brl, dateTime } from '@/lib/format';
import { PageHeader } from './AdminApp';
import { useDebounced } from './OrdersPage';

interface CustomerRow { id: string; name: string; email: string; phone: string | null; document: string | null; orders_count: number; paid_count: number; total_spent_cents: number; last_order_at: string | null }

export default function CustomersPage() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  const { data, isLoading } = useQuery({
    queryKey: ['customers', dq, page],
    queryFn: () => adminApi.get<{ data: CustomerRow[]; total: number; pageSize: number }>(`/customers?${new URLSearchParams({ page: String(page), ...(dq && { q: dq }) })}`),
    placeholderData: keepPreviousData,
  });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <>
      <PageHeader title="Clientes" subtitle={data ? `${data.total} clientes` : undefined} />
      <div className="mb-4"><Input icon={<Search className="h-4 w-4" />} placeholder="Buscar por nome, e-mail ou telefone" value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} /></div>
      {isLoading ? <PageLoader /> : !data?.data.length ? (
        <Card><EmptyState icon={<Users className="h-6 w-6" />} title="Nenhum cliente" /></Card>
      ) : (
        <Card>
          <div className="-m-5 overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead className="border-b border-gray-100 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr><th className="px-5 py-3 font-medium">Cliente</th><th className="px-5 py-3 font-medium">Telefone</th><th className="px-5 py-3 text-right font-medium">Pedidos</th><th className="px-5 py-3 text-right font-medium">Total gasto</th><th className="px-5 py-3 font-medium">Último pedido</th></tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.data.map((c) => (
                  <tr key={c.id}>
                    <td className="px-5 py-3"><p className="font-medium">{c.name}</p><p className="text-xs text-gray-500">{c.email}</p></td>
                    <td className="px-5 py-3 text-gray-600">{c.phone ?? '—'}</td>
                    <td className="px-5 py-3 text-right tabular-nums">{c.paid_count} <span className="text-gray-400">/ {c.orders_count}</span></td>
                    <td className="px-5 py-3 text-right font-semibold tabular-nums">{brl(c.total_spent_cents)}</td>
                    <td className="px-5 py-3 text-gray-600">{dateTime(c.last_order_at)}</td>
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
    </>
  );
}
