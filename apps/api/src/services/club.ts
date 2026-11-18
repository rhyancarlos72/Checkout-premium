import { HttpError, supabase } from '../lib/core.js';
import { ownedProductIds } from './members.js';
import { GRACE_DAYS, cancelSubscription, renewUrl } from './subscriptions.js';

/**
 * Clube de Atividades: área de membros RECORRENTE.
 * Regra central de acesso (uma função só, usada em toda a área de membros):
 *  - produto do Clube: liberado com a assinatura ativa ou em atraso há até 3 dias (tolerância); depois, pausa;
 *  - produtos comprados avulsos (e order bumps): liberados para sempre;
 *  - (etapas seguintes: materiais da biblioteca seguem o Clube; Coleções Premium exigem a compra da coleção).
 */
export async function podeAcessar(customerId: string, alvo: { productId: string }) {
  return (await ownedProductIds(customerId)).has(alvo.productId);
}

const statusPt: Record<string, string> = { pending: 'pendente', active: 'ativa', past_due: 'em atraso', expired: 'expirada', canceled: 'cancelada' };

/** Assinaturas do membro (perfil): status em português, valor contratado, próxima cobrança e se dá para cancelar. */
export async function memberSubscriptions(customerId: string) {
  const { data, error } = await supabase.from('subscriptions').select('*').eq('customer_id', customerId).order('created_at', { ascending: false });
  if (error) return [];
  return ((data ?? []) as any[])
    .filter((s) => s.status !== 'pending' || s.paid_until) // pedido nunca pago não aparece
    .map((s) => ({
      id: s.id,
      status: s.status as string,
      status_label: statusPt[s.status] ?? s.status,
      names: ((s.items ?? []) as any[]).map((i) => i.name),
      plan: s.plan_name ?? null,
      price_cents: s.price_cents,
      paid_until: s.paid_until,
      next_due: s.status === 'canceled' ? null : s.next_due,
      auto: s.rec_status === 'APROVADA', // débito automático autorizado no banco
      grace_until: s.paid_until && s.status === 'past_due' ? new Date(new Date(s.paid_until).getTime() + GRACE_DAYS * 86_400_000).toISOString() : null,
      can_cancel: ['active', 'past_due', 'pending'].includes(s.status),
      renew_url: ['past_due', 'expired'].includes(s.status) ? renewUrl(s.id) : null, // pagar a mensalidade pelo Pix
      canceled_at: s.canceled_at ?? null,
    }));
}

/** Cancelamento pelo próprio membro (perfil): só a assinatura dele; para os débitos e mantém o acesso até o fim do mês pago. */
export async function cancelByMember(customerId: string, subId: string, reason?: string | null) {
  const { data } = await supabase.from('subscriptions').select('id, customer_id').eq('id', subId).maybeSingle();
  if (!data || (data as any).customer_id !== customerId) throw new HttpError(404, 'Assinatura não encontrada');
  await cancelSubscription(subId, { by: 'cliente', reason: reason ?? null });
}
