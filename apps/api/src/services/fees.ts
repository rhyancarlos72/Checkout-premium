import { logger, supabase } from '../lib/core.js';
import { isOwnerOrg, ownerOrgId } from '../lib/tenant.js';

/**
 * Motor de taxas da plataforma (comissão da Prime sobre as vendas dos produtores).
 * - Tudo em centavos inteiros, calculado SÓ no servidor.
 * - A organização proprietária (Prime) é isenta: comissão sempre R$ 0,00 (regra do servidor, não da tela).
 * - Política versionada: cada alteração é uma linha nova; o pedido guarda a política e o valor do momento da compra.
 */
export interface FeePolicy {
  id: string;
  org_id: string | null;
  fixed_cents: number; // por venda aprovada (produto principal)
  percent_bps: number; // 100 = 1% sobre o total
  bump_cents: number; // por order bump vendido
  gateway_fee_payer: 'producer' | 'platform';
  refund_policy: 'keep_fee' | 'refund_fee';
}

export interface FeeLine {
  kind: string;
  price_cents: number;
}

/** Política vigente: a exceção do produtor (se houver) ou a regra geral. */
export async function activePolicy(orgId: string | null): Promise<FeePolicy | null> {
  if (orgId) {
    const { data } = await supabase.from('fee_policies').select('*').eq('org_id', orgId).order('created_at', { ascending: false }).limit(1);
    if (data?.[0]) return data[0] as FeePolicy;
  }
  const { data } = await supabase.from('fee_policies').select('*').is('org_id', null).order('created_at', { ascending: false }).limit(1);
  return (data?.[0] as FeePolicy) ?? null;
}

/** Cálculo puro (testável): comissão da plataforma para as linhas do pedido. */
export function computeFee(policy: Pick<FeePolicy, 'fixed_cents' | 'percent_bps' | 'bump_cents'> | null, lines: FeeLine[], totalCents: number, exempt: boolean) {
  if (exempt || !policy) return { platformFeeCents: 0, fixedCents: 0, bumpCents: 0, percentCents: 0 };
  const mains = lines.filter((l) => l.kind === 'main').length;
  const bumps = lines.filter((l) => l.kind === 'bump').length;
  const fixedCents = mains * policy.fixed_cents;
  const bumpCents = bumps * policy.bump_cents;
  const percentCents = Math.round((totalCents * policy.percent_bps) / 10_000);
  // nunca maior que o próprio valor da venda
  const platformFeeCents = Math.max(0, Math.min(totalCents, fixedCents + bumpCents + percentCents));
  return { platformFeeCents, fixedCents, bumpCents, percentCents };
}

/**
 * Campos de taxa gravados no pedido (retrato do momento da compra).
 * Banco sem o marketplace (migração não rodada): devolve {} e o pedido é criado como antes.
 */
export async function feeFieldsFor(orgId: string | null, lines: FeeLine[], totalCents: number): Promise<Record<string, unknown>> {
  if (!(await ownerOrgId())) return {};
  const exempt = await isOwnerOrg(orgId);
  const policy = exempt ? null : await activePolicy(orgId);
  if (!exempt && !policy) logger.warn({ orgId }, 'Sem política de taxas: venda sem comissão');
  const fee = computeFee(policy, lines, totalCents, exempt);
  return {
    fee_policy_id: policy?.id ?? null,
    platform_fee_cents: fee.platformFeeCents,
    fee_snapshot: {
      owner_exempt: exempt,
      policy: policy ? { fixed_cents: policy.fixed_cents, percent_bps: policy.percent_bps, bump_cents: policy.bump_cents, gateway_fee_payer: policy.gateway_fee_payer, refund_policy: policy.refund_policy } : null,
      ...fee,
    },
  };
}
