import { CalendarDays, CreditCard, KeyRound, User } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/components/ui';
import { brl, digits } from '@/lib/format';

/**
 * Cartão pela Efí (checkout transparente): o cliente digita o cartão aqui, mas a biblioteca OFICIAL da Efí
 * (payment-token-efi) transforma os dados em um payment_token direto no navegador. O número e o CVV
 * nunca são enviados ao nosso servidor. A biblioteca só é baixada quando o cliente escolhe cartão.
 */
export interface EfiCardData {
  number: string;
  name: string;
  expiry: string; // MM/AA
  cvv: string;
  installments: number;
}
export const emptyCard: EfiCardData = { number: '', name: '', expiry: '', cvv: '', installments: 1 };
export interface EfiConfig {
  payeeCode: string;
  sandbox: boolean;
}

// window.__efiTest: só nos testes automatizados (biblioteca simulada); em produção carrega a biblioteca oficial
const loadEfi = (): Promise<any> => ((window as any).__efiTest ? Promise.resolve((window as any).__efiTest) : import('payment-token-efi').then((m: any) => m.default ?? m));

const maskNumber = (v: string) => digits(v).slice(0, 19).replace(/(\d{4})(?=\d)/g, '$1 ');
const maskExpiry = (v: string) => {
  const d = digits(v).slice(0, 4);
  return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
};

/** Validação local (antes de chamar a Efí). */
export function validateCard(c: EfiCardData): Partial<Record<keyof EfiCardData, string>> {
  const e: Partial<Record<keyof EfiCardData, string>> = {};
  const n = digits(c.number);
  if (n.length < 13 || n.length > 19) e.number = 'Número do cartão inválido';
  if (c.name.trim().split(/\s+/).length < 2) e.name = 'Nome como está no cartão';
  const [mm, yy] = c.expiry.split('/');
  const m = Number(mm);
  const y = 2000 + Number(yy);
  const now = new Date();
  if (!(m >= 1 && m <= 12) || !yy || yy.length !== 2 || y < now.getFullYear() || (y === now.getFullYear() && m < now.getMonth() + 1)) e.expiry = 'Validade inválida';
  if (!/^\d{3,4}$/.test(c.cvv)) e.cvv = 'CVV inválido';
  return e;
}

/** Gera o payment_token (com 3DS) na Efí, direto do navegador. */
export async function tokenizeEfiCard(c: EfiCardData, cpf: string, totalCents: number, cfg: EfiConfig) {
  const EfiPay = await loadEfi();
  const number = digits(c.number);
  const env = cfg.sandbox ? 'sandbox' : 'production';
  try {
    const brand = await EfiPay.CreditCard.setCardNumber(number).verifyCardBrand();
    if (!brand || brand === 'undefined' || brand === 'unsupported') throw { error_description: 'Bandeira não aceita. Use Visa, Mastercard, Elo ou Amex.' };
    const [mm, yy] = c.expiry.split('/');
    const r = await EfiPay.CreditCard.setAccount(cfg.payeeCode)
      .setEnvironment(env)
      .setCreditCardData({
        brand,
        number,
        cvv: c.cvv,
        expirationMonth: mm,
        expirationYear: `20${yy}`,
        holderName: c.name.trim(),
        holderDocument: digits(cpf),
        reuse: false,
        enable3ds: true,
        totalValue: totalCents,
      })
      .getPaymentToken();
    if (!r?.payment_token || !r?.tds_identifier) throw r;
    return { payment_token: r.payment_token as string, tds_identifier: r.tds_identifier as string };
  } catch (err: any) {
    throw new Error(err?.error_description || err?.message || 'Não foi possível validar o cartão. Confira os dados.');
  }
}

/** Verificação 3DS pedida pelo banco: envia o cliente para a tela do banco (ele volta para a página do pedido). */
export function submitThreeDS(ch: { action_url: string; creq: string; threeDSSessionData: string }) {
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = ch.action_url;
  for (const [name, value] of [['creq', ch.creq], ['threeDSSessionData', ch.threeDSSessionData]] as const) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

function Input({ label, icon, error, className, ...input }: { label: string; icon: ReactNode; error?: string; className?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-2 block text-[14px] font-bold text-ck-text">
        {label} <span className="text-red-500">*</span>
      </span>
      <span className="relative block">
        <input className="ck-input ck-input-plain ck-input-icon peer" aria-invalid={error ? true : undefined} {...input} />
        <span aria-hidden className={cn('pointer-events-none absolute left-3.5 top-1/2 flex -translate-y-1/2 text-ck-muted transition-colors peer-focus:text-brand [&>svg]:h-[18px] [&>svg]:w-[18px]', error && 'text-red-500')}>{icon}</span>
      </span>
      {error && <span className="mt-1.5 block text-[13px] font-medium text-red-500">{error}</span>}
    </label>
  );
}

/** Campos do cartão (mesmo visual dos campos do checkout) + parcelas calculadas pela Efí. */
export function EfiCardFields({ value, onChange, errors, totalCents, maxInstallments, cfg }: { value: EfiCardData; onChange: (v: EfiCardData) => void; errors: Partial<Record<keyof EfiCardData, string>>; totalCents: number; maxInstallments: number; cfg: EfiConfig }) {
  const [options, setOptions] = useState<{ n: number; label: string }[]>([]);
  const set = (patch: Partial<EfiCardData>) => onChange({ ...value, ...patch });
  const bin = digits(value.number).slice(0, 6);

  // parcelas reais da sua conta Efí para a bandeira e o valor (com ou sem juros, conforme a Efí)
  useEffect(() => {
    const fallback = Array.from({ length: maxInstallments }, (_, i) => ({ n: i + 1, label: i === 0 ? `1x de ${brl(totalCents)} (à vista)` : `${i + 1}x` }));
    if (bin.length < 6 || maxInstallments <= 1) return setOptions(fallback);
    let alive = true;
    loadEfi()
      .then(async (EfiPay) => {
        const brand = await EfiPay.CreditCard.setCardNumber(digits(value.number)).verifyCardBrand();
        if (!brand || brand === 'undefined' || brand === 'unsupported') return fallback;
        const r = await EfiPay.CreditCard.setAccount(cfg.payeeCode).setEnvironment(cfg.sandbox ? 'sandbox' : 'production').setBrand(brand).setTotal(totalCents).getInstallments();
        const list = ((r as any)?.installments ?? []) as { installment: number; has_interest: boolean; value: number }[];
        return list.length
          ? list.filter((p) => p.installment <= maxInstallments).map((p) => ({ n: p.installment, label: `${p.installment}x de ${brl(p.value)}${p.installment === 1 ? ' (à vista)' : p.has_interest ? ' (com juros)' : ' sem juros'}` }))
          : fallback;
      })
      .catch(() => fallback)
      .then((o) => alive && setOptions(o));
    return () => {
      alive = false;
    };
  }, [bin, totalCents, maxInstallments, cfg.payeeCode, cfg.sandbox]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="grid gap-4">
      <Input label="Número do cartão" icon={<CreditCard strokeWidth={1.9} />} error={errors.number} value={value.number} onChange={(e) => set({ number: maskNumber(e.target.value) })} inputMode="numeric" autoComplete="cc-number" placeholder="0000 0000 0000 0000" />
      <Input label="Nome impresso no cartão" icon={<User strokeWidth={1.9} />} error={errors.name} value={value.name} onChange={(e) => set({ name: e.target.value.toUpperCase().slice(0, 60) })} autoComplete="cc-name" placeholder="COMO ESTÁ NO CARTÃO" />
      <div className="grid grid-cols-2 gap-4">
        <Input label="Validade" icon={<CalendarDays strokeWidth={1.9} />} error={errors.expiry} value={value.expiry} onChange={(e) => set({ expiry: maskExpiry(e.target.value) })} inputMode="numeric" autoComplete="cc-exp" placeholder="MM/AA" />
        <Input label="CVV" icon={<KeyRound strokeWidth={1.9} />} error={errors.cvv} value={value.cvv} onChange={(e) => set({ cvv: digits(e.target.value).slice(0, 4) })} inputMode="numeric" autoComplete="cc-csc" placeholder="123" />
      </div>
      {maxInstallments > 1 && (
        <label className="block">
          <span className="mb-2 block text-[14px] font-bold text-ck-text">Parcelas</span>
          <select className="ck-input ck-input-plain" value={value.installments} onChange={(e) => set({ installments: Number(e.target.value) })}>
            {options.map((o) => (
              <option key={o.n} value={o.n}>{o.label}</option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
