import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, BadgeCheck, Check, ChevronDown, Clock, CreditCard, Gift, Lock, Mail, Megaphone, Phone, ShieldCheck, Star, Tag, User, X, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useForm, type UseFormRegisterReturn } from 'react-hook-form';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { cn } from '@/components/ui';
import { ApiError, publicApi } from '@/lib/api';
import { brl, digits, maskPhone, productCode } from '@/lib/format';
import { collectTracking, ensureMetaCookies, initMetaPixel, pixel, setPixelUser, track } from '@/lib/tracking';
import { themeDefaults, themeStyle, usePrefersDark, type PublicCheckout } from './theme';

function makeSchema(fields: PublicCheckout['fields']) {
  return z.object({
    name: z
      .string()
      .trim()
      .min(3, 'Informe seu nome completo')
      .refine((v) => v.split(/\s+/).length >= 2, 'Informe nome e sobrenome'),
    email: z.string().trim().toLowerCase().email('Digite um e-mail válido'),
    phone: fields.phone ? z.string().refine((v) => digits(v).length >= 10, 'Informe o celular com DDD') : z.string().optional(),
  });
}
type FormValues = z.infer<ReturnType<typeof makeSchema>>;

// ------------------------------------------------------------------ peças

/** Logo oficial do Pix (marca do Banco Central), cor #32BCAD. */
export function PixIcon({ className, color = '#32BCAD' }: { className?: string; color?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} role="img" aria-label="Pix">
      <path
        fill={color}
        d="M5.283 18.36a3.505 3.505 0 0 0 2.493-1.032l3.6-3.6a.684.684 0 0 1 .946 0l3.613 3.613a3.504 3.504 0 0 0 2.493 1.032h.71l-4.56 4.56a3.647 3.647 0 0 1-5.156 0L4.85 18.36ZM18.428 5.627a3.505 3.505 0 0 0-2.493 1.032l-3.613 3.614a.67.67 0 0 1-.946 0l-3.6-3.6A3.505 3.505 0 0 0 5.283 5.64h-.434l4.573-4.572a3.646 3.646 0 0 1 5.156 0l4.559 4.559ZM1.068 9.422 3.79 6.699h1.492a2.483 2.483 0 0 1 1.744.722l3.6 3.6a1.73 1.73 0 0 0 2.443 0l3.614-3.613a2.482 2.482 0 0 1 1.744-.723h1.767l2.737 2.737a3.646 3.646 0 0 1 0 5.156l-2.736 2.736h-1.768a2.482 2.482 0 0 1-1.744-.722l-3.613-3.613a1.77 1.77 0 0 0-2.444 0l-3.6 3.6a2.483 2.483 0 0 1-1.744.722H3.791l-2.723-2.723a3.646 3.646 0 0 1 0-5.156"
      />
    </svg>
  );
}

/** Logo Pix + palavra "pix" (como nos apps dos bancos). */
export function PixLogo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-bold lowercase tracking-tight text-[#32BCAD]', className)}>
      <PixIcon className="h-[1.15em] w-[1.15em]" /> pix
    </span>
  );
}

function Countdown({ minutes, text, preview }: { minutes: number; text?: string; preview?: boolean }) {
  const [left, setLeft] = useState(() => {
    if (preview) return minutes * 60;
    const key = `ck_timer_${location.pathname}`;
    try {
      const saved = Number(sessionStorage.getItem(key));
      if (saved > Date.now()) return Math.round((saved - Date.now()) / 1000);
      sessionStorage.setItem(key, String(Date.now() + minutes * 60000));
    } catch {
      /* armazenamento indisponível */
    }
    return minutes * 60;
  });
  useEffect(() => setLeft(minutes * 60), [minutes, preview]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setInterval(() => setLeft((l) => Math.max(0, l - 1)), 1000);
    return () => clearInterval(t);
  }, []);
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  return (
    <span className="inline-flex items-center gap-2">
      <Clock className="h-4 w-4" />
      {left > 0 ? text || 'Oferta reservada por' : 'Últimas unidades com este preço'}
      {left > 0 && (
        <span className="inline-flex gap-1 font-mono font-bold tabular-nums">
          <span className="rounded bg-black/20 px-1.5 py-0.5">{mm}</span>:<span className="rounded bg-black/20 px-1.5 py-0.5">{ss}</span>
        </span>
      )}
    </span>
  );
}

function Section({ step, title, children, aside }: { step?: number; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="ck-card overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b border-ck-border bg-ck-surface-2 px-5 py-3.5 @lg:px-6">
        <h2 className="flex items-center gap-3 text-[13px] font-bold uppercase tracking-[.06em] text-ck-text">
          {step && <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand text-[12px] font-bold text-brand-fg shadow-sm shadow-brand/30">{step}</span>}
          {title}
        </h2>
        {aside}
      </header>
      <div className="p-5 @lg:p-6">{children}</div>
    </section>
  );
}

function CkField({
  label,
  required = true,
  error,
  hint,
  valid,
  reg,
  className,
  ...input
}: { label: string; required?: boolean; error?: string; hint?: string; valid?: boolean; reg: UseFormRegisterReturn; className?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-2 block text-[14px] font-bold text-ck-text">
        {label} {required && <span className="text-red-500">*</span>}
      </span>
      <span className="relative block">
        <input className="ck-input ck-input-plain" aria-invalid={error ? true : undefined} {...reg} {...input} />
        {valid && !error && (
          <span className="animate-pop absolute right-3.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full bg-emerald-500 text-white">
            <Check className="h-3 w-3" strokeWidth={3} />
          </span>
        )}
      </span>
      {error ? <span className="mt-1.5 block text-xs font-medium text-red-500">{error}</span> : hint ? <span className="mt-1.5 block text-xs text-ck-muted">{hint}</span> : null}
    </label>
  );
}

// ------------------------------------------------------------------ view

/**
 * Checkout completo. Usa container queries (@container) — o layout responde à
 * largura do próprio checkout, então funciona igual no celular, no desktop e
 * na pré-visualização do painel.
 */
export function CheckoutView({ checkout, preview = false }: { checkout: PublicCheckout; preview?: boolean }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  // baixa a tela do Pix em segundo plano: ao finalizar, ela abre na hora
  useEffect(() => {
    if (preview) return;
    const id = setTimeout(() => void import('./PaymentPage'), 1500);
    return () => clearTimeout(id);
  }, [preview]);
  const [params] = useSearchParams();
  const t = { ...themeDefaults, ...checkout.theme };
  const prefersDark = usePrefersDark();
  const [bumps, setBumps] = useState<string[]>([]);
  const [couponInput, setCouponInput] = useState('');
  const [coupon, setCoupon] = useState<{ code: string; discount: number } | null>(null);
  const [couponMsg, setCouponMsg] = useState<string | null>(null);
  const [couponOpen, setCouponOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [ctaVisible, setCtaVisible] = useState(true);
  const ctaRef = useRef<HTMLButtonElement>(null);
  const footerRef = useRef<HTMLElement>(null);
  const [footerVisible, setFooterVisible] = useState(false);
  const startedRef = useRef(false);
  const eventIds = useMemo(() => ({ ic: `ic_${crypto.randomUUID()}`, purchase: `purchase_${crypto.randomUUID()}` }), []);

  const schema = useMemo(() => makeSchema(checkout.fields), [checkout.fields]);
  const { register, handleSubmit, setValue, formState, watch, reset, getFieldState } = useForm<FormValues>({
    resolver: zodResolver(schema),
    mode: 'onTouched',
    defaultValues: { name: '', email: '', phone: '' },
  });

  useEffect(() => {
    if (preview) return;
    document.title = `${checkout.product.name} · Pagamento seguro`;
    ensureMetaCookies(); // registra fbclid/fbp já na chegada (horário do clique)
    initMetaPixel(checkout.tracking.metaPixelId);
    track(checkout.slug, 'page_view');
    const recover = params.get('recover');
    if (recover && /^[a-f0-9]{48}$/.test(recover)) {
      publicApi
        .get<{ customer: { name: string; email: string; phone: string | null } | null }>(`/orders/${recover}`)
        .then((o) => o.customer && reset({ name: o.customer.name, email: o.customer.email, phone: maskPhone(o.customer.phone ?? '') }))
        .catch(() => {});
    }
  }, [checkout.slug]); // eslint-disable-line react-hooks/exhaustive-deps

  // Barra fixa no celular aparece só quando o botão principal sai da tela
  useEffect(() => {
    const el = ctaRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setCtaVisible(e.isIntersecting), { threshold: 0.2 });
    io.observe(el);
    const fo = footerRef.current ? new IntersectionObserver(([e]) => setFooterVisible(e.isIntersecting)) : null;
    if (fo && footerRef.current) fo.observe(footerRef.current);
    return () => (io.disconnect(), fo?.disconnect());
  }, []);

  const values = watch();
  useEffect(() => {
    if (preview || startedRef.current || !(values.email || values.name)) return;
    startedRef.current = true;
    track(checkout.slug, 'initiate_checkout');
    pixel('InitiateCheckout', { value: checkout.price_cents / 100, currency: 'BRL', content_name: checkout.product.name, content_type: 'product', content_ids: checkout.product.number ? [productCode(checkout.product.number)] : [], num_items: 1 }, eventIds.ic);
  }, [values.email, values.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedBumps = checkout.bumps.filter((b) => bumps.includes(b.id));
  const subtotal = checkout.price_cents + selectedBumps.reduce((s, b) => s + b.price_cents, 0);
  const discount = coupon ? Math.min(coupon.discount, subtotal - 1) : 0;
  const total = subtotal - discount;

  const quote = useMutation({
    mutationFn: (p: { code: string; bump_ids: string[] }) =>
      publicApi.post<{ discount_cents: number; coupon: { code: string } | null; coupon_error: string | null }>(`/checkouts/${checkout.slug}/quote`, { bump_ids: p.bump_ids, coupon_code: p.code }),
  });

  async function applyCoupon(code = couponInput, bumpIds = bumps) {
    const c = code.trim().toUpperCase();
    if (!c) return;
    setCouponMsg(null);
    if (preview) return setCouponMsg('Cupons funcionam no checkout publicado.');
    try {
      const r = await quote.mutateAsync({ code: c, bump_ids: bumpIds });
      if (r.coupon) {
        setCoupon({ code: r.coupon.code, discount: r.discount_cents });
        track(checkout.slug, 'coupon_applied', { code: r.coupon.code });
      } else {
        setCoupon(null);
        setCouponMsg(r.coupon_error ?? 'Cupom inválido');
      }
    } catch (e) {
      setCouponMsg(e instanceof ApiError ? e.message : 'Não foi possível validar o cupom');
    }
  }

  function toggleBump(id: string) {
    const on = bumps.includes(id);
    const next = on ? bumps.filter((b) => b !== id) : [...bumps, id];
    setBumps(next);
    if (!preview) track(checkout.slug, on ? 'remove_bump' : 'add_bump', { bump_id: id });
    if (coupon) applyCoupon(coupon.code, next);
  }

  const submit = useMutation({
    mutationFn: (v: FormValues) =>
      publicApi.post<{ token: string; order?: unknown }>('/orders', {
        checkout_slug: checkout.slug,
        customer: { name: v.name, email: v.email, phone: v.phone ? digits(v.phone) : null, document: null },
        bump_ids: bumps,
        coupon_code: coupon?.code ?? null,
        tracking: { ...collectTracking(), initiate_checkout_event_id: eventIds.ic, purchase_event_id: eventIds.purchase },
      }),
    onSuccess: (r) => {
      // a resposta já traz o Pix (QR + copia e cola): a próxima tela abre sem nova consulta
      if (r.order) {
        qc.setQueryData(['order', r.token], r.order);
        const o = r.order as { customer?: { name: string; email: string; phone: string | null }; external_id?: string | null };
        setPixelUser(checkout.tracking.metaPixelId, { email: o.customer?.email, phone: o.customer?.phone, name: o.customer?.name, externalId: o.external_id });
      }
      navigate(`/pedido/${r.token}`);
    },
    onError: (e) => setServerError(e instanceof ApiError ? e.message : 'Não foi possível gerar o Pix. Tente novamente.'),
  });

  const onSubmit = handleSubmit(
    (v) => {
      setServerError(null);
      if (preview) return setServerError('Pré-visualização: o pagamento funciona no link publicado.');
      submit.mutate(v);
    },
    () => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
  );

  const err = formState.errors;
  const isValid = (name: keyof FormValues) => {
    const s = getFieldState(name, formState);
    return s.isTouched && !s.invalid && Boolean(values[name]);
  };
  const banner = t.bannerUrl || t.mockupUrl;
  const compareAt = t.compareAtCents ?? 0;
  const productImage = checkout.product.image_url || t.mockupUrl;
  const busy = submit.isPending;
  const showSticky = !ctaVisible && !footerVisible;

  // ---------- blocos reutilizados (desktop lateral / mobile empilhado)
  const summaryLines = (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        {productImage ? (
          <img src={productImage} alt="" className="h-14 w-14 shrink-0 rounded-[calc(var(--ck-r)*.6)] object-cover ring-1 ring-ck-border" />
        ) : (
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[calc(var(--ck-r)*.6)] bg-brand/10 text-brand"><Gift className="h-6 w-6" /></div>
        )}
        <div className="min-w-0 flex-1">
          <p className="font-medium leading-snug">{checkout.product.name}</p>
          <p className="mt-0.5 text-xs text-ck-muted">{checkout.product.number ? `ID: ${productCode(checkout.product.number)} · ` : ''}Acesso digital imediato</p>
        </div>
        <p className="shrink-0 font-semibold tabular-nums">{brl(checkout.price_cents)}</p>
      </div>
      {selectedBumps.map((b) => (
        <div key={b.id} className="animate-fade-in flex items-center justify-between gap-3 text-sm">
          <span className="flex min-w-0 items-center gap-2 text-ck-muted">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand"><Zap className="h-3 w-3" /></span>
            <span className="truncate text-ck-text">{b.title}</span>
          </span>
          <span className="shrink-0 tabular-nums">{brl(b.price_cents)}</span>
        </div>
      ))}
    </div>
  );

  const couponBlock = (
    <div className="border-t border-dashed border-ck-border pt-4">
      {coupon ? (
        <div className="flex items-center justify-between rounded-[calc(var(--ck-r)*.6)] bg-emerald-500/10 px-3 py-2.5 text-sm">
          <span className="flex items-center gap-2 font-medium text-emerald-600"><Tag className="h-4 w-4" /> {coupon.code} aplicado</span>
          <button type="button" className="rounded p-1 text-emerald-700 hover:bg-emerald-500/10" aria-label="Remover cupom" onClick={() => (setCoupon(null), setCouponInput(''))}><X className="h-4 w-4" /></button>
        </div>
      ) : !couponOpen ? (
        <button type="button" onClick={() => setCouponOpen(true)} className="flex items-center gap-2 text-sm font-medium text-brand hover:underline">
          <Tag className="h-4 w-4" /> Adicionar cupom de desconto
        </button>
      ) : (
        <div>
          <div className="flex gap-2">
            <input
              value={couponInput}
              onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), applyCoupon())}
              placeholder="CÓDIGO"
              autoCapitalize="characters"
              className="ck-input h-11 font-medium uppercase tracking-wider"
              style={{ paddingLeft: 14, paddingRight: 14, height: 44 }}
            />
            <button type="button" onClick={() => applyCoupon()} disabled={quote.isPending} className="h-11 shrink-0 rounded-[calc(var(--ck-r)*.75)] border-[1.5px] border-ck-border px-4 text-sm font-semibold transition hover:bg-ck-surface-2 disabled:opacity-60">
              {quote.isPending ? '...' : 'Aplicar'}
            </button>
          </div>
          {couponMsg && <p className="mt-1.5 text-xs font-medium text-red-500">{couponMsg}</p>}
        </div>
      )}
    </div>
  );

  const totals = (
    <div className="space-y-2 border-t border-ck-border pt-4 text-sm">
      <div className="flex justify-between text-ck-muted"><span>Subtotal</span><span className="tabular-nums">{brl(subtotal)}</span></div>
      {discount > 0 && <div className="flex justify-between font-medium text-emerald-600"><span>Desconto</span><span className="tabular-nums">−{brl(discount)}</span></div>}
      <div className="flex items-end justify-between pt-1">
        <span className="font-semibold">Total</span>
        <span className="text-right">
          <span className="block font-display text-[28px] font-bold leading-none tracking-tight tabular-nums">{brl(total)}</span>
          <span className="mt-1 flex items-center justify-end gap-1 text-xs text-ck-muted">à vista no <PixIcon className="h-3 w-3" /> Pix</span>
        </span>
      </div>
    </div>
  );

  const guarantee = (
    <div className="ck-card space-y-4 p-5 text-sm">
      {t.guaranteeDays > 0 && (
        <div className="flex gap-3">
          <div className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
            <ShieldCheck className="h-5 w-5" />
            <span className="absolute -bottom-1 -right-1 rounded-full bg-emerald-600 px-1 text-[10px] font-bold text-white">{t.guaranteeDays}d</span>
          </div>
          <div>
            <p className="font-semibold">Garantia incondicional de {t.guaranteeDays} dias</p>
            <p className="mt-0.5 leading-relaxed text-ck-muted">{t.guaranteeText || 'Se não gostar por qualquer motivo, devolvemos 100% do seu dinheiro.'}</p>
          </div>
        </div>
      )}
      <div className="flex gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-500"><Zap className="h-5 w-5" /></div>
        <div>
          <p className="font-semibold">Acesso imediato</p>
          <p className="mt-0.5 leading-relaxed text-ck-muted">Assim que o Pix é confirmado, o acesso chega no seu e-mail.</p>
        </div>
      </div>
      <div className="flex gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-sky-500/10 text-sky-500"><Lock className="h-5 w-5" /></div>
        <div>
          <p className="font-semibold">Compra 100% segura</p>
          <p className="mt-0.5 leading-relaxed text-ck-muted">Conexão criptografada e pagamento processado por instituição autorizada pelo Banco Central.</p>
        </div>
      </div>
    </div>
  );

  const testimonials = (t.testimonials?.length ?? 0) > 0 && (
    <div className="space-y-3">
      {t.testimonials!.filter((x) => x.text).map((tm, i) => (
        <figure key={i} className="ck-card p-5 text-sm">
          <div className="mb-2 flex gap-0.5 text-amber-400">{[0, 1, 2, 3, 4].map((s) => <Star key={s} className="h-4 w-4 fill-current" />)}</div>
          <blockquote className="leading-relaxed">“{tm.text}”</blockquote>
          <figcaption className="mt-3 flex items-center gap-2.5 text-[13px] font-semibold">
            {tm.avatarUrl ? <img src={tm.avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" loading="lazy" /> : <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand/15 text-xs font-bold text-brand">{tm.name?.[0] ?? '★'}</span>}
            {tm.name}
            <BadgeCheck className="h-4 w-4 text-sky-500" />
          </figcaption>
        </figure>
      ))}
    </div>
  );

  const seals = t.showSeals && (
    <div className="grid grid-cols-3 gap-2 text-center text-[11px] font-medium leading-tight text-ck-muted">
      <div className="flex flex-col items-center gap-1.5 rounded-[calc(var(--ck-r)*.6)] border border-ck-border px-2 py-3"><Lock className="h-4 w-4 text-emerald-500" /> Site seguro<br />SSL 256 bits</div>
      <div className="flex flex-col items-center gap-1.5 rounded-[calc(var(--ck-r)*.6)] border border-ck-border px-2 py-3"><PixIcon className="h-4 w-4" /> Pix aprovado<br />na hora</div>
      <div className="flex flex-col items-center gap-1.5 rounded-[calc(var(--ck-r)*.6)] border border-ck-border px-2 py-3"><ShieldCheck className="h-4 w-4 text-sky-500" /> Dados<br />protegidos</div>
    </div>
  );

  return (
    <div style={themeStyle(t, prefersDark)} className={cn('@container relative bg-ck-bg font-checkout text-ck-text antialiased [overflow:clip]', preview ? 'min-h-full' : 'min-h-screen')}>
      {/* Barra de anúncio / cronômetro */}
      {(t.showTimer || t.announcement) && (
        <div className="bg-brand text-brand-fg">
          <div className="mx-auto flex min-h-10 max-w-[1120px] flex-wrap items-center justify-center gap-x-6 gap-y-1 px-4 py-2 text-center text-[13px] font-medium">
            {t.announcement && <span className="inline-flex items-center gap-2"><Megaphone className="h-4 w-4" /> {t.announcement}</span>}
            {t.showTimer && <Countdown minutes={t.timerMinutes} text={t.timerText} preview={preview} />}
          </div>
        </div>
      )}

      {/* Cabeçalho */}
      <header className="border-b border-ck-border bg-ck-surface/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1120px] items-center justify-between gap-4 px-4">
          {t.logoUrl ? (
            <img src={t.logoUrl} alt="" className="h-8 w-auto max-w-[150px] object-contain" />
          ) : (
            <span className="flex items-center gap-2 text-sm font-semibold"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600"><Lock className="h-4 w-4" /></span> Checkout seguro</span>
          )}
          <span className="flex shrink-0 items-center gap-2 text-xs font-medium text-ck-muted">
            <span className="hidden @sm:inline">Pagamento via</span> <PixLogo className="text-sm" />
          </span>
        </div>
      </header>

      {/* Resumo recolhível (celular) */}
      <div className="border-b border-ck-border bg-ck-surface @4xl:hidden">
        <button type="button" onClick={() => setSummaryOpen(!summaryOpen)} className="mx-auto flex w-full max-w-[1120px] items-center justify-between px-4 py-3.5 text-sm" aria-expanded={summaryOpen}>
          <span className="flex items-center gap-2 font-medium text-brand">
            <CreditCard className="h-4 w-4" /> {summaryOpen ? 'Ocultar' : 'Ver'} resumo do pedido
            <ChevronDown className={cn('h-4 w-4 transition', summaryOpen && 'rotate-180')} />
          </span>
          <span className="text-base font-bold tabular-nums">{brl(total)}</span>
        </button>
        {summaryOpen && (
          <div className="animate-fade-in mx-auto max-w-[1120px] space-y-4 px-4 pb-5">
            {summaryLines}
            {couponBlock}
            {totals}
          </div>
        )}
      </div>

      <main className="mx-auto grid max-w-[1120px] gap-5 px-4 pb-10 pt-5 @4xl:grid-cols-[minmax(0,1fr)_380px] @4xl:gap-8 @4xl:pt-10 @5xl:grid-cols-[minmax(0,1fr)_400px]">
        <form id="ck-form" noValidate onSubmit={onSubmit} className="min-w-0 space-y-5">
          {/* Banner no topo (celular) */}
          {banner && <img src={banner} alt={checkout.product.name} className="h-auto w-full rounded-ck object-cover shadow-sm @4xl:hidden" fetchPriority="high" />}

          {/* Produto — compacto: imagem à esquerda, nome e preço ao lado */}
          <section className="ck-card overflow-hidden">
            <div className="flex items-center gap-4 p-4 @lg:gap-5 @lg:p-5">
              {productImage ? (
                <div className="flex h-[84px] w-[84px] shrink-0 items-center justify-center overflow-hidden rounded-[calc(var(--ck-r)*.6)] border border-ck-border bg-[#fff] p-1 @lg:h-24 @lg:w-24">
                  <img src={productImage} alt={checkout.product.name} className="h-full w-full object-contain" />
                </div>
              ) : (
                <div className="flex h-[84px] w-[84px] shrink-0 items-center justify-center rounded-[calc(var(--ck-r)*.6)] bg-gradient-to-br from-brand to-brand/60 text-brand-fg @lg:h-24 @lg:w-24"><Gift className="h-8 w-8" /></div>
              )}
              <div className="min-w-0 flex-1">
                <h1 className="font-display text-[19px] font-bold leading-snug tracking-tight @lg:text-[24px]">{t.headline || checkout.product.name}</h1>
                {t.producerName && (
                  <p className="mt-0.5 flex items-center gap-1 text-[12px] text-ck-muted">por <span className="font-semibold text-ck-text">{t.producerName}</span> <BadgeCheck className="h-3.5 w-3.5 text-sky-500" /></p>
                )}
                {compareAt > checkout.price_cents && (
                  <p className="mt-1.5 flex items-center gap-2 text-[12px] text-ck-muted">
                    De <span className="line-through">{brl(compareAt)}</span>
                    <span className="rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-bold text-emerald-600">-{Math.round((1 - checkout.price_cents / compareAt) * 100)}%</span>
                  </p>
                )}
                <p className={cn('flex flex-wrap items-baseline gap-x-2', compareAt > checkout.price_cents ? 'mt-0.5' : 'mt-1.5')}>
                  <span className="font-display text-[24px] font-extrabold leading-tight tracking-tight text-brand tabular-nums @lg:text-[28px]">{brl(checkout.price_cents)}</span>
                  <span className="text-[13px] text-ck-muted">à vista no Pix</span>
                </p>
              </div>
            </div>
            {(t.subheadline || checkout.product.description) && (
              <p className="border-t border-ck-border px-4 py-3 text-[13px] leading-relaxed text-ck-muted @lg:px-5">{t.subheadline || checkout.product.description}</p>
            )}

            {(t.benefits?.filter(Boolean).length ?? 0) > 0 && (
              <div className="border-t border-ck-border bg-ck-surface-2/60 px-5 py-5 @lg:px-8">
                <ul className="mx-auto grid max-w-xl gap-2.5 @lg:grid-cols-2">
                  {t.benefits!.filter(Boolean).map((b, i) => (
                    <li key={i} className="flex items-start gap-2.5 text-left text-sm">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand text-brand-fg"><Check className="h-3 w-3" strokeWidth={3.5} /></span>
                      <span className="leading-snug">{b}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <Section step={1} title="Dados pessoais">
            <div className="grid gap-4">
              <CkField label="Nome completo" reg={register('name')} error={err.name?.message} valid={isValid('name')} autoComplete="name" placeholder="Digite seu nome completo" enterKeyHint="next" />
              <CkField label="E-mail" reg={register('email')} error={err.email?.message} valid={isValid('email')} type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} placeholder="Digite seu melhor e-mail" hint="Você receberá o acesso neste e-mail" enterKeyHint="next" />
              {checkout.fields.phone && (
                <CkField
                  label="Celular (WhatsApp)"
                  reg={{ ...register('phone'), onChange: async (e) => setValue('phone', maskPhone(e.target.value), { shouldValidate: formState.isSubmitted }) }}
                  error={err.phone?.message}
                  valid={isValid('phone')}
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel-national"
                  placeholder="(00) 00000-0000"
                />
              )}
            </div>
          </Section>

          <Section step={2} title="Pagamento" aside={<span className="hidden items-center gap-1 text-xs text-ck-muted @sm:flex"><Lock className="h-3.5 w-3.5" /> Ambiente seguro</span>}>
            <div className="flex flex-wrap gap-3">
              <button type="button" aria-pressed="true" className="flex h-[84px] w-[112px] flex-col items-center justify-center gap-2 rounded-[calc(var(--ck-r)*.8)] border-2 border-brand bg-brand/[.07] shadow-[0_0_0_4px_color-mix(in_srgb,var(--brand)_10%,transparent)]">
                <PixIcon className="h-7 w-7" />
                <span className="text-[13px] font-bold text-ck-text">Pix</span>
              </button>
            </div>
            <ol className="mt-4 rounded-[calc(var(--ck-r)*.8)] border border-ck-border bg-ck-surface-2 px-4">
              {[
                [`Clique em “${t.buttonText || 'Finalizar compra'}”`, 'Geramos na hora o QR Code e o código Pix “copia e cola” do seu pedido.'],
                ['Pague no app do seu banco', 'Abra o app do banco, escolha Pix, escaneie o QR Code ou cole o código copiado.'],
                ['Acesso liberado automaticamente', 'A confirmação é em segundos e o produto chega no seu e-mail assim que o pagamento cair.'],
              ].map(([title, text], i) => (
                <li key={i} className={cn('flex gap-3 py-3.5', i > 0 && 'border-t border-dashed border-ck-border')}>
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/15 text-[12px] font-bold text-brand">{i + 1}</span>
                  <div>
                    <p className="text-[14px] font-bold leading-snug">{title}</p>
                    <p className="mt-0.5 text-[13px] leading-relaxed text-ck-muted">{text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Section>

          {/* Order bumps */}
          {checkout.bumps.length > 0 && (
            <div className="space-y-4">
              {checkout.bumps.map((b) => {
                const on = bumps.includes(b.id);
                const off = b.compare_at_cents && b.compare_at_cents > b.price_cents ? Math.round((1 - b.price_cents / b.compare_at_cents) * 100) : 0;
                return (
                  <div
                    key={b.id}
                    className={cn(
                      'relative overflow-hidden rounded-ck border-2 border-dashed transition-all duration-300',
                      on ? 'border-brand bg-brand/[.06] shadow-xl shadow-brand/15' : 'ck-bump-idle border-amber-400 bg-ck-surface',
                    )}
                  >
                    {/* faixa superior */}
                    <div className={cn('flex items-center justify-between gap-2 px-4 py-2 text-[12px] font-extrabold uppercase tracking-wider', on ? 'bg-brand text-brand-fg' : 'bg-gradient-to-r from-amber-400 to-orange-400 text-amber-950')}>
                      <span className="flex items-center gap-1.5"><Zap className="h-3.5 w-3.5 fill-current" /> Oferta única · só nesta página</span>
                      {off > 0 && <span className="rounded-full bg-black/15 px-2 py-0.5">-{off}%</span>}
                    </div>

                    <button type="button" onClick={() => toggleBump(b.id)} aria-pressed={on} className="block w-full text-left">
                      <div className="flex gap-4 p-4 @lg:p-5">
                        <div className="relative shrink-0">
                          {b.image_url ? (
                            <img src={b.image_url} alt="" className="h-[88px] w-[88px] rounded-[calc(var(--ck-r)*.6)] object-cover shadow-md ring-1 ring-ck-border @md:h-24 @md:w-24" loading="lazy" />
                          ) : (
                            <div className="flex h-[88px] w-[88px] items-center justify-center rounded-[calc(var(--ck-r)*.6)] bg-gradient-to-br from-amber-300 to-orange-400 text-amber-950 shadow-md @md:h-24 @md:w-24"><Gift className="h-9 w-9" /></div>
                          )}
                          {off > 0 && <span className="absolute -right-2 -top-2 rounded-full bg-red-500 px-1.5 py-0.5 text-[11px] font-extrabold text-white shadow-md">-{off}%</span>}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-[15px] font-bold leading-snug">{b.title}</p>
                          {b.description && <p className="mt-1 text-[13px] leading-relaxed text-ck-muted">{b.description}</p>}
                          <div className="mt-2.5 flex flex-wrap items-baseline gap-x-2">
                            {b.compare_at_cents ? <span className="text-[13px] text-ck-muted line-through">{brl(b.compare_at_cents)}</span> : null}
                            <span className="text-[22px] font-extrabold leading-none tracking-tight text-brand">{brl(b.price_cents)}</span>
                          </div>
                        </div>
                      </div>

                      {/* barra de ação */}
                      <div
                        className={cn(
                          'flex items-center gap-3 border-t-2 border-dashed px-4 py-3.5 text-[14px] font-extrabold transition-colors duration-300',
                          on ? 'border-brand/30 bg-brand text-brand-fg' : 'border-amber-300 bg-amber-300 text-amber-950',
                        )}
                      >
                        {!on && <ArrowRight className="ck-nudge h-5 w-5 shrink-0" strokeWidth={3} />}
                        <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 transition', on ? 'border-brand-fg bg-brand-fg text-brand' : 'border-amber-950/60 bg-[#fff]')}>
                          {on && <Check className="h-4 w-4" strokeWidth={3.5} />}
                        </span>
                        <span className="flex-1 leading-snug">{on ? 'Adicionado ao seu pedido!' : `Sim! Quero adicionar por ${brl(b.price_cents)}`}</span>
                      </div>
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Resumo + CTA (celular) */}
          <section className="ck-card space-y-4 p-5 @4xl:hidden">
            <h2 className="font-display text-[18px] font-semibold tracking-tight">Resumo do pedido</h2>
            {summaryLines}
            {couponBlock}
            {totals}
          </section>

          {serverError && <div className="animate-fade-in rounded-[calc(var(--ck-r)*.75)] border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm font-medium text-red-600">{serverError}</div>}

          <div className="space-y-4">
            <button ref={ctaRef} type="submit" disabled={busy} className="ck-cta flex h-[60px] w-full items-center justify-center gap-2.5 text-[17px] font-bold disabled:opacity-70">
              {busy ? (
                <><span className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" /> Gerando seu Pix…</>
              ) : (
                <><Lock className="h-[18px] w-[18px]" /> {t.buttonText || 'Finalizar compra'} · {brl(total)}</>
              )}
            </button>
            <p className="flex items-center justify-center gap-1.5 text-center text-xs text-ck-muted"><ShieldCheck className="h-3.5 w-3.5" /> Ambiente seguro. Seus dados não são compartilhados.</p>
            {seals}
          </div>

          <div className="space-y-5 @4xl:hidden">
            {guarantee}
            {testimonials}
          </div>
        </form>

        {/* Coluna lateral (desktop) */}
        <aside className="hidden min-w-0 @4xl:block">
          <div className="sticky top-6 space-y-5">
            {banner && <img src={banner} alt={checkout.product.name} className="h-auto w-full rounded-ck object-cover shadow-sm" fetchPriority="high" />}
            <section className="ck-card space-y-4 p-6">
              <h2 className="font-display text-[18px] font-semibold tracking-tight">Resumo do pedido</h2>
              {summaryLines}
              {couponBlock}
              {totals}
            </section>
            {guarantee}
            {testimonials}
          </div>
        </aside>
      </main>

      <footer ref={footerRef} className="border-t border-ck-border">
        <div className="mx-auto max-w-[1120px] space-y-2 px-4 py-8 text-center text-xs leading-relaxed text-ck-muted">
          <p className="mx-auto max-w-md text-center font-medium leading-relaxed">
            <ShieldCheck className="mr-1 inline h-3.5 w-3.5 align-[-2px] text-emerald-500" />Compra protegida · dados criptografados · pagamento via <PixIcon className="mx-0.5 inline h-3 w-3 align-[-1px]" />Pix
          </p>
          {t.footerText && <p className="whitespace-pre-line">{t.footerText}</p>}
          {(t.producerName || checkout.store.document || checkout.store.supportEmail) && (
            <p>
              {[t.producerName && `© ${new Date().getFullYear()} ${t.producerName}`, checkout.store.document].filter(Boolean).join(' · ')}
              {checkout.store.supportEmail && <>{(t.producerName || checkout.store.document) && ' · '}Suporte: <a className="underline underline-offset-2" href={`mailto:${checkout.store.supportEmail}`}>{checkout.store.supportEmail}</a></>}
            </p>
          )}
        </div>
      </footer>

      {/* CTA fixo (celular) — aparece quando o botão principal sai da tela */}
      {t.stickyMobileCta && (
        // h-0: não ocupa espaço no fim da página (sem área vazia na rolagem)
        <div className="pointer-events-none sticky bottom-0 z-30 h-0 @4xl:hidden">
          <div className={cn('absolute inset-x-0 bottom-0 flex items-center gap-3 border-t border-ck-border bg-ck-surface/95 px-4 py-3 pb-[max(.75rem,env(safe-area-inset-bottom))] backdrop-blur-md transition-all duration-300', showSticky ? 'pointer-events-auto visible translate-y-0 opacity-100' : 'invisible translate-y-3 opacity-0')}>
            <div className="min-w-0">
              <p className="text-[11px] text-ck-muted">Total</p>
              <p className="text-lg font-bold leading-tight tabular-nums">{brl(total)}</p>
            </div>
            <button type="submit" form="ck-form" disabled={busy} className="ck-cta flex h-12 flex-1 items-center justify-center gap-2 text-[15px] font-bold disabled:opacity-70">
              <Lock className="h-4 w-4" /> {t.buttonText || 'Finalizar compra'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
