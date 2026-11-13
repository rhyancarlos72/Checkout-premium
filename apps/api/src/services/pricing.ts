/**
 * Cálculo de preço 100% no servidor. O navegador nunca define valores:
 * só informa quais bumps marcou e o código do cupom.
 */
export interface CouponRow {
  id: string;
  code: string;
  type: 'percent' | 'fixed';
  value: number;
  max_uses: number | null;
  used_count: number;
  min_cents: number;
  checkout_id: string | null;
  expires_at: string | null;
  active: boolean;
}

export interface PriceLine {
  kind: 'main' | 'bump';
  name: string;
  price_cents: number;
  product_id?: string | null;
  bump_id?: string | null;
  /** order bump de assinatura mensal (Pix Automático) */
  recurring?: boolean;
  /** valor de cada mês da assinatura (o 1º mês é o price_cents, pago junto com o pedido) */
  monthly_cents?: number;
}

export type CouponCheck = { ok: true; discountCents: number } | { ok: false; reason: string };

export function checkCoupon(coupon: CouponRow | null, checkoutId: string, subtotalCents: number, now = new Date()): CouponCheck {
  if (!coupon || !coupon.active) return { ok: false, reason: 'Cupom inválido' };
  if (coupon.checkout_id && coupon.checkout_id !== checkoutId) return { ok: false, reason: 'Cupom não vale para este produto' };
  if (coupon.expires_at && new Date(coupon.expires_at) < now) return { ok: false, reason: 'Cupom expirado' };
  if (coupon.max_uses !== null && coupon.used_count >= coupon.max_uses) return { ok: false, reason: 'Cupom esgotado' };
  if (subtotalCents < coupon.min_cents) return { ok: false, reason: 'Valor mínimo não atingido para este cupom' };
  const raw = coupon.type === 'percent' ? Math.round((subtotalCents * coupon.value) / 100) : coupon.value;
  return { ok: true, discountCents: Math.min(raw, subtotalCents) };
}

/** Valor mínimo aceito pelos gateways PIX (R$ 0,01). */
export const MIN_CHARGE_CENTS = 1;

export function computeTotals(lines: PriceLine[], discountCents: number) {
  const subtotal = lines.reduce((s, l) => s + l.price_cents, 0);
  const discount = Math.max(0, Math.min(discountCents, subtotal - MIN_CHARGE_CENTS));
  return { subtotalCents: subtotal, discountCents: discount, totalCents: subtotal - discount };
}
