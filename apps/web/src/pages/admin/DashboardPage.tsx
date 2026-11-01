import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { BadgeCheck, CalendarDays, Check, ChevronDown, Package, Timer, TrendingUp, Trophy } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { cn } from '@/components/ui';
import { adminApi } from '@/lib/api';
import { brl, productCode } from '@/lib/format';
import { PixIcon } from '../checkout/CheckoutView';

interface Dashboard {
  products: { id: string; name: string; number?: number | null }[];
  kpis: {
    paid_cents: number;
    paid_count: number;
    pending_cents: number;
    pending_count: number;
    orders_count: number;
    initiated_count: number;
    page_views: number;
    checkout_conversion: number;
    pix_conversion: number;
    bump_cents: number;
    bump_count: number;
    recovered_cents: number;
    recovered_count: number;
    avg_ticket_cents: number;
  };
  hourly: { hour: number; paid: number; revenue_cents: number }[];
  methods: { method: string; label: string; count: number; revenue_cents: number }[];
  top_products: { name: string; kind: string; number?: number | null; count: number; revenue_cents: number }[];
}

// ------------------------------------------------------------------ período
type Range = { from: Date; to: Date; label: string; key: string };
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const fmtDay = (d: Date) => d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'short', year: 'numeric' }).replace(/\./g, '');
function preset(key: string): Range {
  const today = startOfDay(new Date());
  const tomorrow = addDays(today, 1);
  switch (key) {
    case 'yesterday':
      return { key, label: 'Ontem', from: addDays(today, -1), to: today };
    case '7d':
      return { key, label: 'Últimos 7 dias', from: addDays(today, -6), to: tomorrow };
    case '30d':
      return { key, label: 'Últimos 30 dias', from: addDays(today, -29), to: tomorrow };
    case 'month':
      return { key, label: 'Este mês', from: new Date(today.getFullYear(), today.getMonth(), 1), to: tomorrow };
    case 'lastmonth':
      return { key, label: 'Mês passado', from: new Date(today.getFullYear(), today.getMonth() - 1, 1), to: new Date(today.getFullYear(), today.getMonth(), 1) };
    default:
      return { key: 'today', label: 'Hoje', from: today, to: tomorrow };
  }
}
const toInput = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function useClickOutside(ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    const on = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    document.addEventListener('mousedown', on);
    return () => document.removeEventListener('mousedown', on);
  }, [ref, close]);
}

function Dropdown({ button, children, align = 'left' }: { button: (open: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false));
  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen(!open)}>{button(open)}</div>
      {open && (
        <div className={cn('animate-fade-in absolute z-30 mt-2 min-w-[240px] rounded-2xl border border-zinc-200 bg-white p-2 shadow-2xl shadow-black/20', align === 'right' ? 'right-0' : 'left-0')}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

const pillBtn = 'flex h-12 items-center gap-2.5 rounded-xl border border-zinc-200 bg-white px-4 text-[15px] font-medium text-zinc-800 shadow-sm transition hover:border-zinc-300';

// ------------------------------------------------------------------ KPI
function Kpi({ label, value, sub, icon, glow, tile }: { label: string; value: string; sub?: string; icon?: ReactNode; glow?: string; tile?: string }) {
  return (
    <div className="kpi-glow rounded-2xl border border-zinc-200 bg-white p-6 shadow-[0_1px_2px_rgba(16,24,40,.04)]" style={glow ? ({ ['--glow' as any]: glow } as React.CSSProperties) : { ['--glow' as any]: 'transparent' }}>
      <div className="relative flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[15px] text-zinc-600">{label}</p>
          <p className="mt-1.5 text-[30px] font-bold leading-none tracking-tight text-zinc-900 tabular-nums">{value}</p>
          {sub && <p className="mt-2 text-[13px] text-zinc-500">{sub}</p>}
        </div>
        {icon && <div className={cn('flex h-12 w-12 shrink-0 items-center justify-center rounded-xl shadow-lg', tile ?? 'bg-[#fff]')}>{icon}</div>}
      </div>
    </div>
  );
}

const pct = (v: number) => `${(v * 100).toFixed(v > 0 && v < 0.1 ? 1 : 0).replace('.', ',')}%`;

export default function DashboardPage({ name }: { name?: string }) {
  const [range, setRange] = useState<Range>(() => preset('today'));
  const [productId, setProductId] = useState<string>('');
  const [custom, setCustom] = useState({ from: toInput(new Date()), to: toInput(new Date()) });

  const qs = useMemo(() => new URLSearchParams({ from: range.from.toISOString(), to: range.to.toISOString(), ...(productId && { product_id: productId }) }).toString(), [range, productId]);
  const { data, isFetching } = useQuery({
    queryKey: ['dashboard', qs],
    queryFn: () => adminApi.get<Dashboard>(`/dashboard?${qs}`),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  const k = data?.kpis;
  const lastDay = addDays(range.to, -1);
  const rangeLabel = startOfDay(range.from).getTime() === startOfDay(lastDay).getTime() ? fmtDay(range.from) : `${fmtDay(range.from)} - ${fmtDay(lastDay)}`;
  const productName = data?.products.find((p) => p.id === productId)?.name;
  const hourly = (data?.hourly ?? []).map((h) => ({ ...h, label: `${String(h.hour).padStart(2, '0')}h`, revenue: h.revenue_cents / 100 }));
  const methods = (data?.methods ?? []).filter((m) => m.count > 0);
  const methodColors: Record<string, string> = { woovi: '#2563eb', efi: '#06b6d4' };
  const totalMethods = methods.reduce((s, m) => s + m.revenue_cents, 0);

  return (
    <>
      <div className="mb-7">
        <h1 className="font-display text-[32px] font-bold leading-tight tracking-tight text-zinc-900">Visão Geral</h1>
        <p className="mt-1 text-[15px] text-zinc-600">{name ? `Olá, ${name.split(' ')[0]}! ` : ''}Resumo em tempo real do seu negócio</p>
      </div>

      {/* Filtros */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Dropdown
          button={(open) => (
            <button className={pillBtn}>
              <CalendarDays className="h-[18px] w-[18px] text-zinc-500" />
              <span className="truncate">{rangeLabel}</span>
              <ChevronDown className={cn('h-4 w-4 text-zinc-500 transition', open && 'rotate-180')} />
              {isFetching && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-300 border-t-blue-500" />}
            </button>
          )}
        >
          {(close) => (
            <div className="w-[280px]">
              {['today', 'yesterday', '7d', '30d', 'month', 'lastmonth'].map((key) => {
                const p = preset(key);
                return (
                  <button key={key} onClick={() => (setRange(p), close())} className={cn('flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm transition hover:bg-zinc-100', range.key === key && 'font-semibold text-blue-600')}>
                    {p.label} {range.key === key && <Check className="h-4 w-4" />}
                  </button>
                );
              })}
              <div className="mt-1 border-t border-zinc-100 px-1 pt-3">
                <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">Personalizado</p>
                <div className="grid grid-cols-2 gap-2 px-1">
                  <input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} className="h-10 rounded-lg border border-zinc-200 bg-white px-2 text-sm text-zinc-800" />
                  <input type="date" value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} className="h-10 rounded-lg border border-zinc-200 bg-white px-2 text-sm text-zinc-800" />
                </div>
                <button
                  onClick={() => {
                    const [fy, fm, fd] = custom.from.split('-').map(Number);
                    const [ty, tm, td] = custom.to.split('-').map(Number);
                    setRange({ key: 'custom', label: 'Personalizado', from: new Date(fy, fm - 1, fd), to: new Date(ty, tm - 1, td + 1) });
                    close();
                  }}
                  className="mx-1 mt-2 h-10 w-[calc(100%-.5rem)] rounded-lg bg-blue-600 text-sm font-semibold text-white hover:bg-blue-500"
                >
                  Aplicar período
                </button>
              </div>
            </div>
          )}
        </Dropdown>

        <Dropdown
          align="right"
          button={(open) => (
            <button className={pillBtn}>
              <Package className="h-[18px] w-[18px] text-zinc-500" />
              <span className="max-w-[220px] truncate">{productName ? `${data?.products.find((p) => p.id === productId)?.number ? `#${data?.products.find((p) => p.id === productId)?.number} · ` : ''}${productName}` : 'Todos os produtos'}</span>
              <ChevronDown className={cn('h-4 w-4 text-zinc-500 transition', open && 'rotate-180')} />
            </button>
          )}
        >
          {(close) => (
            <div className="max-h-80 w-[280px] overflow-y-auto">
              {[{ id: '', name: 'Todos os produtos' }, ...(data?.products ?? [])].map((p) => (
                <button key={p.id || 'all'} onClick={() => (setProductId(p.id), close())} className={cn('flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left text-sm transition hover:bg-zinc-100', productId === p.id && 'font-semibold text-blue-600')}>
                  <span className="truncate">{'number' in p && p.number ? <span className="mr-1.5 font-mono text-xs text-zinc-400">ID: {productCode(p.number)}</span> : null}{p.name}</span> {productId === p.id && <Check className="h-4 w-4 shrink-0" />}
                </button>
              ))}
            </div>
          )}
        </Dropdown>
      </div>

      {/* KPIs */}
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        <Kpi label="Vendas (pagas)" value={brl(k?.paid_cents ?? 0)} sub={`${k?.paid_count ?? 0} vendas`} glow="rgb(59 130 246 / .22)" icon={<BadgeCheck className="h-6 w-6 text-blue-600" />} />
        <Kpi label="Vendas pendentes" value={brl(k?.pending_cents ?? 0)} sub={`${k?.pending_count ?? 0} pendentes`} glow="rgb(245 158 11 / .22)" tile="bg-amber-300" icon={<Timer className="h-6 w-6 text-amber-900" />} />
        <Kpi label="Conversão do checkout" value={pct(k?.checkout_conversion ?? 0)} sub={`${k?.initiated_count ?? 0} checkouts iniciados`} glow="rgb(59 130 246 / .22)" icon={<TrendingUp className="h-6 w-6 text-blue-600" />} />
        <Kpi label="Vendas de Orderbump" value={brl(k?.bump_cents ?? 0)} sub={`${k?.bump_count ?? 0} orderbumps`} />
        <Kpi label="Valor Recuperado" value={brl(k?.recovered_cents ?? 0)} sub={k?.recovered_count ? `${k.recovered_count} vendas após e-mail de recuperação` : undefined} />
        <Kpi label="Ticket médio" value={brl(k?.avg_ticket_cents ?? 0)} sub={k?.orders_count ? `Pix pago em ${pct(k.pix_conversion)} dos pedidos` : undefined} />
      </div>

      {/* Gráficos */}
      <div className="mt-6 grid gap-5 xl:grid-cols-3">
        <section className="rounded-2xl border border-zinc-200 bg-white p-6 xl:col-span-2">
          <div className="mb-5 flex items-center justify-between">
            <h2 className="font-display text-lg font-semibold text-zinc-900">Vendas por Hora</h2>
            <span className="text-xs text-zinc-500">faturamento pago · horário de Brasília</span>
          </div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hourly} margin={{ top: 4, right: 0, left: 0, bottom: 0 }} barCategoryGap={3}>
                <CartesianGrid vertical={false} stroke="currentColor" className="text-zinc-200" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={4} tick={{ fontSize: 11, fill: '#94a3b8' }} />
                <YAxis tickLine={false} axisLine={false} width={68} allowDecimals={false} tick={{ fontSize: 11, fill: '#94a3b8' }} tickFormatter={(v) => (v ? `R$${Number(v).toLocaleString('pt-BR', { notation: 'compact' })}` : '0')} />
                <Tooltip
                  cursor={{ fill: 'rgba(59,130,246,.08)' }}
                  contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 12, color: '#fff', fontSize: 13 }}
                  labelStyle={{ color: '#94a3b8' }}
                  formatter={(v, _n, p: any) => [`${brl(Math.round(Number(v) * 100))} · ${p.payload.paid} vendas`, 'Faturamento']}
                />
                <Bar dataKey="revenue" fill="#3b82f6" radius={[4, 4, 0, 0]} maxBarSize={22} animationDuration={500} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <h2 className="mb-5 font-display text-lg font-semibold text-zinc-900">Vendas por método</h2>
          {methods.length === 0 ? (
            <div className="flex h-60 flex-col items-center justify-center gap-3 text-center text-sm text-zinc-500">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-100"><PixIcon className="h-7 w-7" /></div>
              Nenhuma venda paga no período.
            </div>
          ) : (
            <>
              <div className="relative h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={methods} dataKey="revenue_cents" nameKey="label" innerRadius="68%" outerRadius="92%" animationDuration={500} paddingAngle={methods.length > 1 ? 3 : 0} stroke="none">
                      {methods.map((m) => <Cell key={m.method} fill={methodColors[m.method] ?? '#64748b'} />)}
                    </Pie>
                    <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 12, color: '#fff', fontSize: 13 }} formatter={(v) => brl(Number(v))} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                  <PixIcon className="h-6 w-6" />
                  <p className="mt-1 text-lg font-bold text-zinc-900">{brl(totalMethods)}</p>
                </div>
              </div>
              <ul className="mt-4 space-y-2.5">
                {methods.map((m) => (
                  <li key={m.method} className="flex items-center gap-3 text-sm">
                    <span className="h-3 w-3 rounded-full" style={{ background: methodColors[m.method] }} />
                    <span className="flex-1 text-zinc-700">{m.label}</span>
                    <span className="text-zinc-500">{m.count} · {totalMethods ? pct(m.revenue_cents / totalMethods) : '0%'}</span>
                    <span className="font-semibold tabular-nums text-zinc-900">{brl(m.revenue_cents)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      {/* Funil + ranking */}
      <div className="mt-6 grid gap-5 xl:grid-cols-5">
        <section className="rounded-2xl border border-zinc-200 bg-white p-6 xl:col-span-3">
          <h2 className="mb-5 font-display text-lg font-semibold text-zinc-900">Funil de conversão</h2>
          <div className="space-y-4">
            {[
              { label: 'Visitas ao checkout', value: k?.page_views ?? 0 },
              { label: 'Começaram a preencher', value: k?.initiated_count ?? 0 },
              { label: 'Geraram Pix', value: k?.orders_count ?? 0 },
              { label: 'Pagaram', value: k?.paid_count ?? 0 },
            ].map((f, i, arr) => {
              const max = Math.max(arr[0].value, 1);
              const rate = i > 0 && arr[i - 1].value > 0 ? f.value / arr[i - 1].value : null;
              return (
                <div key={f.label}>
                  <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
                    <span className="truncate font-medium text-zinc-700">{f.label}</span>
                    <span className="flex shrink-0 items-baseline gap-2">
                      {rate !== null && <span className="text-xs text-zinc-400">{pct(rate)}</span>}
                      <span className="font-semibold tabular-nums text-zinc-900">{f.value.toLocaleString('pt-BR')}</span>
                    </span>
                  </div>
                  <div className="h-2.5 overflow-hidden rounded-full bg-zinc-100">
                    <div className="h-full rounded-full bg-gradient-to-r from-blue-600 to-cyan-400 transition-all duration-700" style={{ width: `${Math.max(1.5, (f.value / max) * 100)}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
        <section className="rounded-2xl border border-zinc-200 bg-white p-6 xl:col-span-2">
          <h2 className="mb-4 flex items-center gap-2 font-display text-lg font-semibold text-zinc-900"><Trophy className="h-5 w-5 text-amber-500" /> Mais vendidos</h2>
          {(data?.top_products.length ?? 0) === 0 ? (
            <p className="py-8 text-center text-sm text-zinc-500">Nenhuma venda paga no período.</p>
          ) : (
            <ol className="space-y-1">
              {data!.top_products.map((p, i) => (
                <li key={p.kind + p.name} className="flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-zinc-50">
                  <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold', i === 0 ? 'bg-amber-100 text-amber-700' : 'bg-zinc-100 text-zinc-500')}>{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-zinc-900">{p.name}</p>
                    <p className="text-xs text-zinc-500">{p.number ? `ID: ${productCode(p.number)} · ` : ''}{p.count} vendas{p.kind === 'bump' && ' · order bump'}</p>
                  </div>
                  <span className="text-sm font-semibold tabular-nums text-zinc-900">{brl(p.revenue_cents)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </>
  );
}
