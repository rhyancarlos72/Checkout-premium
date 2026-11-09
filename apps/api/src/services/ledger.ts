import { logger, supabase } from '../lib/core.js';
import { ownerOrgId } from '../lib/tenant.js';

/**
 * Livro-razão: cada fato financeiro vira um lançamento imutável (o banco recusa alterar/apagar).
 * Um índice único por (pedido, tipo) garante que webhook repetido nunca duplica venda nem comissão.
 * Valores: + entra para o produtor, − sai dele.
 */
async function insertOnce(row: { org_id: string; order_id: string; type: string; amount_cents: number; data?: unknown }) {
  const { error } = await supabase.from('ledger_entries').insert({ data: {}, ...row });
  if (error && !/duplicate|unique/i.test(error.message)) logger.error({ err: error.message, row }, 'Livro-razão: falha ao lançar');
}

/** Venda aprovada: valor bruto + comissão da plataforma (zero para a Prime). */
export async function recordSale(orderId: string) {
  if (!(await ownerOrgId())) return; // banco sem marketplace
  const { data } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();
  const o: any = data;
  if (!o?.org_id) return;
  await insertOnce({ org_id: o.org_id, order_id: o.id, type: 'sale', amount_cents: o.total_cents, data: { provider: o.provider, method: o.payment_method ?? 'pix', split: o.split_info?.gateway ?? null } });
  if (o.split_status === 'pending') await supabase.from('orders').update({ split_status: 'done' }).eq('id', o.id); // pago com split: o gateway dividiu
  if (o.platform_fee_cents > 0) await insertOnce({ org_id: o.org_id, order_id: o.id, type: 'platform_fee', amount_cents: -o.platform_fee_cents });
}

/** Reembolso: estorna o valor; devolve a comissão só se a política do pedido mandar. */
export async function recordRefund(orderId: string) {
  if (!(await ownerOrgId())) return;
  const { data } = await supabase.from('orders').select('id, org_id, total_cents, platform_fee_cents, fee_snapshot').eq('id', orderId).maybeSingle();
  const o: any = data;
  if (!o?.org_id) return;
  await insertOnce({ org_id: o.org_id, order_id: o.id, type: 'refund', amount_cents: -o.total_cents });
  if (o.platform_fee_cents > 0 && o.fee_snapshot?.policy?.refund_policy === 'refund_fee') await insertOnce({ org_id: o.org_id, order_id: o.id, type: 'fee_reversal', amount_cents: o.platform_fee_cents });
}

/** Chargeback (contestação): estorna o valor da venda. */
export async function recordChargeback(orderId: string) {
  if (!(await ownerOrgId())) return;
  const { data } = await supabase.from('orders').select('id, org_id, total_cents').eq('id', orderId).maybeSingle();
  const o: any = data;
  if (!o?.org_id) return;
  await insertOnce({ org_id: o.org_id, order_id: o.id, type: 'chargeback', amount_cents: -o.total_cents });
}
