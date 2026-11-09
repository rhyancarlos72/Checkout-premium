import { useQuery } from '@tanstack/react-query';
import { BadgeCheck, Clock, Percent, ReceiptText, RotateCcw, Wallet } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Badge, Card, cn, EmptyState, PageLoader, Select } from '@/components/ui';
import { adminApi } from '@/lib/api';
import { brl, dateTime } from '@/lib/format';
import { PageHeader } from './AdminApp';

interface Finance {
  enabled: boolean;
  owner?: boolean;
  split_enabled?: boolean;
  gateway?: string | null;
  gross_cents?: number;
  approved_count?: number;
  pending_cents?: number;
  pending_count?: number;
  platform_fees_cents?: number;
  refunds_cents?: number;
  chargebacks_cents?: number;
  net_estimated_cents?: number;
  net_total_cents?: number;
  entries?: { type: string; amount_cents: number; created_at: string; order_id: string | null }[];
}

const TYPES: Record<string, string> = {
  sale: 'Venda aprovada',
  platform_fee: 'Comissão da plataforma',
  gateway_fee: 'Tarifa do gateway',
  refund: 'Reembolso',
  fee_reversal: 'Comissão devolvida',
  chargeback: 'Chargeback',
  payout: 'Repasse',
  adjustment: 'Ajuste',
};

function Kpi({ icon, label, value, hint, tone = 'blue' }: { icon: ReactNode; label: string; value: string; hint?: string; tone?: 'blue' | 'green' | 'amber' | 'red' | 'zinc' }) {
  const tones = { blue: 'bg-blue-50 text-blue-600', green: 'bg-emerald-50 text-emerald-600', amber: 'bg-amber-50 text-amber-600', red: 'bg-red-50 text-red-600', zinc: 'bg-zinc-100 text-zinc-600' };
  return (
    <Card>
      <div className="flex items-start gap-3">
        <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', tones[tone])}>{icon}</span>
        <div className="min-w-0">
          <p className="text-[13px] text-zinc-500">{label}</p>
          <p className="pv mt-0.5 font-display text-[22px] font-bold tracking-tight text-zinc-900">{value}</p>
          {hint && <p className="mt-0.5 text-xs text-zinc-500">{hint}</p>}
        </div>
      </div>
    </Card>
  );
}

/** Financeiro da organização logada: vendas, comissões da plataforma, reembolsos e líquido estimado. */
export default function FinancePage() {
  const [days, setDays] = useState(30);
  const q = useQuery({ queryKey: ['finance', days], queryFn: () => adminApi.get<Finance>(`/finance?from=${new Date(Date.now() - days * 86400_000).toISOString()}`) });
  const d = q.data;
  return (
    <>
      <PageHeader
        title="Financeiro"
        subtitle="Vendas aprovadas, comissão da plataforma, reembolsos e o valor líquido estimado (antes das tarifas do gateway, conforme o contrato)."
        action={
          <div className="w-48 shrink-0">
          <Select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Período">
            <option value={7}>Últimos 7 dias</option>
            <option value={30}>Últimos 30 dias</option>
            <option value={90}>Últimos 90 dias</option>
            <option value={365}>Últimos 12 meses</option>
          </Select>
          </div>
        }
      />
      {q.isLoading || !d ? (
        <PageLoader />
      ) : !d.enabled ? (
        <Card><EmptyState icon={<Wallet className="h-6 w-6" />} title="Financeiro indisponível" text="Rode no Supabase o SQL do marketplace (20261112000000_marketplace_base.sql) para ativar os relatórios financeiros." /></Card>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            {d.owner ? <Badge tone="paid">Conta proprietária · isenta de taxas da plataforma</Badge> : d.split_enabled ? <Badge tone="paid">Recebimento ativo{d.gateway ? ` · ${d.gateway === 'efi' ? 'Efí' : 'Woovi'}` : ''}</Badge> : <Badge tone="pending">Recebimento em configuração: vendas liberadas após a ativação</Badge>}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <Kpi icon={<BadgeCheck className="h-5 w-5" />} tone="green" label="Vendas aprovadas (bruto)" value={brl(d.gross_cents ?? 0)} hint={`${d.approved_count ?? 0} vendas`} />
            <Kpi icon={<Percent className="h-5 w-5" />} tone="blue" label="Comissão da plataforma" value={brl(d.platform_fees_cents ?? 0)} hint={d.owner ? 'Sempre R$ 0,00 na conta proprietária' : 'R$ por venda + por order bump'} />
            <Kpi icon={<Wallet className="h-5 w-5" />} tone="green" label="Líquido estimado" value={brl(d.net_estimated_cents ?? 0)} hint="Antes das tarifas do gateway" />
            <Kpi icon={<Clock className="h-5 w-5" />} tone="amber" label="Pix pendentes" value={brl(d.pending_cents ?? 0)} hint={`${d.pending_count ?? 0} pedidos aguardando`} />
            <Kpi icon={<RotateCcw className="h-5 w-5" />} tone="red" label="Reembolsos" value={brl(d.refunds_cents ?? 0)} />
            <Kpi icon={<ReceiptText className="h-5 w-5" />} tone="zinc" label="Chargebacks" value={brl(d.chargebacks_cents ?? 0)} />
          </div>
          <Card title="Lançamentos recentes">
            {!d.entries?.length ? (
              <p className="text-sm text-zinc-500">Nenhum lançamento ainda. Cada venda aprovada gera aqui o valor bruto e a comissão da plataforma.</p>
            ) : (
              <div className="-mx-5 -mb-5 divide-y divide-zinc-100">
                {d.entries.map((e, i) => (
                  <div key={i} className="flex items-center gap-3 px-5 py-3 text-sm">
                    <span className="flex-1 font-medium text-zinc-800">{TYPES[e.type] ?? e.type}</span>
                    <span className="hidden text-xs text-zinc-500 sm:block">{dateTime(e.created_at)}</span>
                    <span className={cn('pv w-28 text-right font-semibold tabular-nums', e.amount_cents < 0 ? 'text-red-600' : 'text-emerald-600')}>{e.amount_cents < 0 ? '−' : '+'}{brl(Math.abs(e.amount_cents))}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
