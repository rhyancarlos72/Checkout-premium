import { useQuery } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, Clock, Percent, Receipt, ShoppingBag, Sparkles, Trophy } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, cn, Spinner } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { adminApi } from '@/lib/api';
import { brl } from '@/lib/format';

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

function Delta({ cur, prev, dark }: { cur: number; prev: number; dark?: boolean }) {
  if (!prev) return <span className={cn('text-xs', dark ? 'text-zinc-400' : 'text-zinc-400')}>sem período anterior</span>;
  const d = (cur - prev) / prev;
  const up = d >= 0;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold',
        up ? (dark ? 'bg-emerald-400/15 text-emerald-300' : 'bg-emerald-50 text-emerald-700') : dark ? 'bg-red-400/15 text-red-300' : 'bg-red-50 text-red-600',
      )}
    >
      {up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
      {pct(Math.abs(d))}
    </span>
  );
}

function Kpi({ icon, tone, label, value, foot }: { icon: ReactNode; tone: string; label: string; value: string; foot?: ReactNode }) {
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-zinc-200/70 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,.04),0_8px_24px_-12px_rgba(16,24,40,.08)] transition hover:-translate-y-0.5 hover:shadow-[0_12px_32px_-12px_rgba(16,24,40,.18)]">
      <div className={cn('pointer-events-none absolute -right-8 -top-8 h-24 w-24 rounded-full opacity-60 blur-2xl transition group-hover:opacity-100', tone)} />
      <div className="relative flex items-center justify-between">
        <p className="text-sm font-medium text-zinc-500">{label}</p>
        <div className={cn('flex h-9 w-9 items-center justify-center rounded-xl text-white shadow-lg', tone)}>{icon}</div>
      </div>
      <p className="relative mt-3 text-[26px] font-bold tabular-nums tracking-tight text-zinc-900">{value}</p>
      <div className="relative mt-1 min-h-5 text-xs text-zinc-500">{foot}</div>
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

export default function DashboardPage() {
  const [days, setDays] = useState(30);
  const { session } = useAuth();
  const { data, isLoading } = useQuery({ queryKey: ['dashboard', days], queryFn: () => adminApi.get<Dashboard>(`/dashboard?days=${days}`) });

  const range = (
    <div className="inline-flex rounded-xl border border-zinc-200 bg-white p-1 text-sm shadow-sm">
      {[7, 30, 90].map((d) => (
        <button key={d} onClick={() => setDays(d)} className={cn('rounded-lg px-3.5 py-1.5 font-medium transition', days === d ? 'bg-zinc-900 text-zinc-50 shadow' : 'text-zinc-600 hover:bg-zinc-100')}>
          {d}d
        </button>
      ))}
    </div>
  );

  const header = (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="text-sm font-medium text-zinc-500">{new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        <h1 className="mt-1 text-[28px] font-bold leading-tight tracking-tight text-zinc-900">
          {greeting()}, {session?.user.email?.split('@')[0]} 👋
        </h1>
      </div>
      {range}
    </div>
  );

  if (isLoading || !data)
    return (
      <>
        {header}
        <div className="flex h-64 items-center justify-center"><Spinner className="h-7 w-7" /></div>
      </>
    );

  const k = data.kpis;
  const series = data.series.map((s) => ({
    ...s,
    label: new Date(s.day + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
    revenue: s.revenue_cents / 100,
  }));
  const funnel = [
    { label: 'Visitas ao checkout', value: data.funnel.page_view },
    { label: 'Começaram a preencher', value: data.funnel.initiate_checkout },
    { label: 'Geraram PIX', value: data.funnel.pix_generated },
    { label: 'Pagaram', value: data.funnel.paid },
  ];
  const fmax = Math.max(...funnel.map((f) => f.value), 1);
  const noData = k.orders === 0 && data.funnel.page_view === 0;

  return (
    <>
      {header}

      {/* Hero: faturamento */}
      <section className="relative overflow-hidden rounded-3xl bg-[#07090f] p-6 text-white shadow-2xl shadow-zinc-900/20 sm:p-8">
        <div className="pointer-events-none absolute -left-20 -top-28 h-72 w-72 rounded-full bg-emerald-500/30 blur-3xl" />
        <div className="pointer-events-none absolute -right-16 top-10 h-64 w-64 rounded-full bg-cyan-500/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 left-1/3 h-64 w-64 rounded-full bg-violet-600/25 blur-3xl" />
        <div className="bg-grid pointer-events-none absolute inset-0 opacity-60" />
        <div className="relative grid gap-6 lg:grid-cols-[280px_1fr] lg:items-end">
          <div>
            <p className="text-sm font-medium text-zinc-400">Faturamento · últimos {days} dias</p>
            <p className="mt-2 text-4xl font-bold tabular-nums tracking-tight sm:text-5xl">{brl(k.revenue_cents)}</p>
            <div className="mt-3 flex items-center gap-2 text-sm text-zinc-400">
              <Delta cur={k.revenue_cents} prev={k.previous.revenue_cents} dark /> vs. período anterior
            </div>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <div className="glass rounded-2xl p-3">
                <p className="text-xs text-zinc-400">Vendas pagas</p>
                <p className="mt-0.5 text-xl font-bold tabular-nums">{k.paid}</p>
              </div>
              <div className="glass rounded-2xl p-3">
                <p className="text-xs text-zinc-400">PIX gerados</p>
                <p className="mt-0.5 text-xl font-bold tabular-nums">{k.orders}</p>
              </div>
            </div>
          </div>
          <div className="h-56 sm:h-64">
            {series.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-white/10 text-center text-sm text-zinc-400">
                Ainda sem vendas neste período.
                <Link to="/admin/checkouts" className="rounded-xl bg-white/10 px-4 py-2 font-medium text-white hover:bg-white/15">Criar um checkout</Link>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series} margin={{ top: 10, right: 4, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#34d399" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="rgba(255,255,255,.06)" />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: '#71717a' }} minTickGap={20} />
                  <YAxis tickLine={false} axisLine={false} width={56} tick={{ fontSize: 11, fill: '#71717a' }} tickFormatter={(v) => `R$${Number(v).toLocaleString('pt-BR', { notation: 'compact' })}`} />
                  <Tooltip
                    cursor={{ stroke: 'rgba(255,255,255,.25)', strokeDasharray: '3 3' }}
                    contentStyle={{ background: '#111827', border: '1px solid rgba(255,255,255,.1)', borderRadius: 12, color: '#fff', fontSize: 13 }}
                    labelStyle={{ color: '#a1a1aa' }}
                    formatter={(v, _n, p: any) => [`${brl(Math.round(Number(v) * 100))} · ${p.payload.paid} vendas`, 'Faturamento']}
                  />
                  <Area type="monotone" dataKey="revenue" stroke="#34d399" strokeWidth={2} fill="url(#rev)" activeDot={{ r: 5, stroke: '#07090f', strokeWidth: 2, fill: '#34d399' }} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </section>

      {/* KPIs */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi icon={<Receipt className="h-[18px] w-[18px]" />} tone="bg-gradient-to-br from-violet-500 to-fuchsia-500" label="Ticket médio" value={brl(k.avg_ticket_cents)} foot={<Delta cur={k.avg_ticket_cents} prev={k.previous.avg_ticket_cents} />} />
        <Kpi icon={<Percent className="h-[18px] w-[18px]" />} tone="bg-gradient-to-br from-emerald-500 to-teal-500" label="Conversão do PIX" value={pct(k.conversion_pix)} foot="PIX pagos ÷ PIX gerados" />
        <Kpi icon={<Sparkles className="h-[18px] w-[18px]" />} tone="bg-gradient-to-br from-amber-400 to-orange-500" label="Order bumps" value={pct(k.bump_take_rate)} foot="das vendas levaram uma oferta extra" />
        <Kpi icon={<Clock className="h-[18px] w-[18px]" />} tone="bg-gradient-to-br from-sky-500 to-indigo-500" label="Aguardando pagamento" value={brl(k.pending_cents)} foot={`${k.pending_count} PIX pendentes · recuperação automática`} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-5">
        <Card title="Funil de conversão" className="min-w-0 xl:col-span-3">
          {noData ? (
            <p className="py-10 text-center text-sm text-zinc-500">O funil aparece assim que o checkout receber as primeiras visitas.</p>
          ) : (
            <div className="space-y-4">
              {funnel.map((f, i) => {
                const rate = i > 0 && funnel[i - 1].value > 0 ? f.value / funnel[i - 1].value : null;
                return (
                  <div key={f.label} title={`${f.label}: ${f.value}`}>
                    <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate font-medium text-zinc-700">{f.label}</span>
                      <span className="flex shrink-0 items-baseline gap-2">
                        {rate !== null && <span className="text-xs text-zinc-400">{pct(rate)}<span className="hidden sm:inline"> da etapa anterior</span></span>}
                        <span className="font-semibold tabular-nums text-zinc-900">{f.value.toLocaleString('pt-BR')}</span>
                      </span>
                    </div>
                    <div className="h-3 overflow-hidden rounded-full bg-zinc-100">
                      <div className="h-3 rounded-full bg-gradient-to-r from-emerald-500 to-cyan-500 transition-all duration-700" style={{ width: `${Math.max(2, (f.value / fmax) * 100)}%`, opacity: 1 - i * 0.12 }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card title={<span className="flex items-center gap-2"><Trophy className="h-4 w-4 text-amber-500" /> Mais vendidos</span>} className="min-w-0 xl:col-span-2">
          {data.top_products.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-zinc-500">
              <ShoppingBag className="h-6 w-6 text-zinc-300" /> Nenhuma venda paga no período.
            </div>
          ) : (
            <ol className="-my-1 space-y-1">
              {data.top_products.map((p, i) => (
                <li key={p.kind + p.name} className="flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-zinc-50">
                  <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold', i === 0 ? 'bg-amber-100 text-amber-700' : i === 1 ? 'bg-zinc-200 text-zinc-700' : i === 2 ? 'bg-orange-100 text-orange-700' : 'bg-zinc-100 text-zinc-500')}>{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-zinc-900">{p.name}</p>
                    <p className="text-xs text-zinc-500">{p.count} vendas{p.kind === 'bump' && ' · order bump'}</p>
                  </div>
                  <span className="text-sm font-semibold tabular-nums text-zinc-900">{brl(p.revenue_cents)}</span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </div>
    </>
  );
}
