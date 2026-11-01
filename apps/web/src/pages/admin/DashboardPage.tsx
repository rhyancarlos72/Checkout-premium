import { useQuery } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, cn, PageLoader } from '@/components/ui';
import { adminApi } from '@/lib/api';
import { brl } from '@/lib/format';
import { PageHeader } from './AdminApp';

interface Dashboard {
  kpis: {
    orders: number;
    paid: number;
    revenue_cents: number;
    avg_ticket_cents: number;
    pending_count: number;
    pending_cents: number;
    conversion_pix: number;
    bump_take_rate: number;
    previous: { orders: number; paid: number; revenue_cents: number; avg_ticket_cents: number };
  };
  funnel: { page_view: number; initiate_checkout: number; pix_generated: number; paid: number };
  series: { day: string; orders: number; paid: number; revenue_cents: number }[];
  top_products: { name: string; kind: string; count: number; revenue_cents: number }[];
}

const pct = (v: number) => `${(v * 100).toFixed(1).replace('.', ',')}%`;

function Delta({ cur, prev }: { cur: number; prev: number }) {
  if (!prev) return null;
  const d = (cur - prev) / prev;
  const up = d >= 0;
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-xs font-medium', up ? 'text-emerald-700' : 'text-red-600')}>
      {up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
      {pct(Math.abs(d))} <span className="font-normal text-gray-500">vs. período anterior</span>
    </span>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums tracking-tight text-gray-900">{value}</p>
      <div className="mt-1 min-h-4">{sub}</div>
    </div>
  );
}

export default function DashboardPage() {
  const [days, setDays] = useState(30);
  const { data, isLoading } = useQuery({ queryKey: ['dashboard', days], queryFn: () => adminApi.get<Dashboard>(`/dashboard?days=${days}`) });

  const range = (
    <div className="inline-flex rounded-xl border border-gray-200 bg-white p-1 text-sm">
      {[7, 30, 90].map((d) => (
        <button key={d} onClick={() => setDays(d)} className={cn('rounded-lg px-3 py-1.5 font-medium', days === d ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100')}>
          {d} dias
        </button>
      ))}
    </div>
  );

  if (isLoading || !data)
    return (
      <>
        <PageHeader title="Visão geral" action={range} />
        <PageLoader />
      </>
    );

  const k = data.kpis;
  const series = data.series.map((s) => ({ ...s, label: new Date(s.day + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }), revenue: s.revenue_cents / 100 }));
  const funnel = [
    { label: 'Visitas', value: data.funnel.page_view },
    { label: 'Iniciaram', value: data.funnel.initiate_checkout },
    { label: 'PIX gerado', value: data.funnel.pix_generated },
    { label: 'Pagos', value: data.funnel.paid },
  ];
  const fmax = Math.max(...funnel.map((f) => f.value), 1);

  return (
    <>
      <PageHeader title="Visão geral" subtitle={`Últimos ${days} dias`} action={range} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Faturamento" value={brl(k.revenue_cents)} sub={<Delta cur={k.revenue_cents} prev={k.previous.revenue_cents} />} />
        <Stat label="Vendas pagas" value={String(k.paid)} sub={<Delta cur={k.paid} prev={k.previous.paid} />} />
        <Stat label="Ticket médio" value={brl(k.avg_ticket_cents)} sub={<span className="text-xs text-gray-500">Order bump em {pct(k.bump_take_rate)} das vendas</span>} />
        <Stat label="Conversão do PIX" value={pct(k.conversion_pix)} sub={<span className="text-xs text-gray-500">{k.pending_count} pendentes · {brl(k.pending_cents)}</span>} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card title="Faturamento por dia" className="xl:col-span-2">
          {series.length === 0 ? (
            <p className="py-16 text-center text-sm text-gray-500">Sem vendas no período.</p>
          ) : (
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={series} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barCategoryGap={2}>
                  <CartesianGrid vertical={false} stroke="#eef0f3" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: '#6b7280' }} minTickGap={16} />
                  <YAxis tickLine={false} axisLine={false} width={64} tick={{ fontSize: 12, fill: '#6b7280' }} tickFormatter={(v) => `R$ ${Number(v).toLocaleString('pt-BR', { notation: 'compact' })}`} />
                  <Tooltip
                    cursor={{ fill: 'rgba(15,118,110,.06)' }}
                    contentStyle={{ borderRadius: 12, border: '1px solid #e5e7eb', fontSize: 13 }}
                    formatter={(v, _n, p: any) => [`${brl(Math.round(Number(v) * 100))} · ${p.payload.paid} vendas`, 'Faturamento']}
                  />
                  <Bar dataKey="revenue" fill="#0f766e" radius={[4, 4, 0, 0]} maxBarSize={28} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card title="Funil de conversão">
          <div className="space-y-4">
            {funnel.map((f, i) => (
              <div key={f.label} title={`${f.label}: ${f.value}`}>
                <div className="mb-1 flex justify-between text-sm">
                  <span className="text-gray-700">{f.label}</span>
                  <span className="font-semibold tabular-nums">
                    {f.value.toLocaleString('pt-BR')}
                    {i > 0 && funnel[i - 1].value > 0 && <span className="ml-2 text-xs font-normal text-gray-500">{pct(f.value / funnel[i - 1].value)}</span>}
                  </span>
                </div>
                <div className="h-2.5 rounded-full bg-gray-100">
                  <div className="h-2.5 rounded-full bg-teal-700 transition-all" style={{ width: `${Math.max(2, (f.value / fmax) * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card title="Mais vendidos" className="mt-6">
        {data.top_products.length === 0 ? (
          <p className="py-6 text-center text-sm text-gray-500">Nenhuma venda paga no período.</p>
        ) : (
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-5 pb-2 font-medium">Item</th>
                  <th className="px-5 pb-2 font-medium">Tipo</th>
                  <th className="px-5 pb-2 text-right font-medium">Vendas</th>
                  <th className="px-5 pb-2 text-right font-medium">Receita</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.top_products.map((p) => (
                  <tr key={p.kind + p.name}>
                    <td className="px-5 py-2.5 font-medium">{p.name}</td>
                    <td className="px-5 py-2.5 text-gray-500">{p.kind === 'bump' ? 'Order bump' : 'Produto'}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums">{p.count}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums">{brl(p.revenue_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
