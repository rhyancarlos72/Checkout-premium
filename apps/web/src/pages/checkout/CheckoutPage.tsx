import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { BadgeCheck, Check, Clock, Lock, Mail, Phone, ShieldCheck, Tag, User, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { Button, cn, Field, Input, PageLoader } from '@/components/ui';
import { ApiError, publicApi } from '@/lib/api';
import { brl, contrastText, digits, isValidCnpj, isValidCpf, maskDocument, maskPhone } from '@/lib/format';
import { collectTracking, initMetaPixel, pixel, track } from '@/lib/tracking';

export interface PublicCheckout {
  id: string;
  slug: string;
  name: string;
  price_cents: number;
  theme: Theme;
  fields: { phone: boolean; document: boolean };
  tracking: { metaPixelId: string | null };
  product: { name: string; description: string | null; image_url: string | null };
  bumps: { id: string; title: string; description: string | null; price_cents: number; compare_at_cents: number | null; image_url: string | null }[];
  store: { name: string; supportEmail: string; document: string };
}
export interface Theme {
  primaryColor?: string;
  backgroundColor?: string;
  buttonText?: string;
  headline?: string;
  logoUrl?: string | null;
  bannerUrl?: string | null;
  mockupUrl?: string | null;
  guaranteeDays?: number;
  guaranteeText?: string;
  showTimer?: boolean;
  timerMinutes?: number;
  testimonials?: { name: string; text: string; avatarUrl?: string | null }[];
  footerText?: string;
}

export function themeStyle(theme: Theme | undefined): CSSProperties {
  const brand = theme?.primaryColor || '#0f766e';
  return { ['--brand' as any]: brand, ['--brand-fg' as any]: contrastText(brand), background: theme?.backgroundColor || '#f5f6f8' };
}

function makeSchema(fields: PublicCheckout['fields']) {
  return z.object({
    name: z
      .string()
      .trim()
      .min(3, 'Informe seu nome completo')
      .refine((v) => v.split(/\s+/).length >= 2, 'Informe nome e sobrenome'),
    email: z.string().trim().toLowerCase().email('Digite um e-mail válido'),
    phone: fields.phone ? z.string().refine((v) => digits(v).length >= 10, 'Telefone com DDD') : z.string().optional(),
    document: fields.document
      ? z.string().refine((v) => isValidCpf(v) || isValidCnpj(v), 'CPF ou CNPJ inválido')
      : z.string().optional(),
  });
}
type FormValues = z.infer<ReturnType<typeof makeSchema>>;

export default function CheckoutPage() {
  const { slug = '' } = useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ['checkout', slug],
    queryFn: () => publicApi.get<PublicCheckout>(`/checkouts/${slug}`),
    retry: 1,
  });

  if (isLoading) return <PageLoader />;
  if (error || !data)
    return (
      <div className="flex min-h-screen items-center justify-center p-6 text-center">
        <div>
          <p className="text-lg font-semibold">Checkout indisponível</p>
          <p className="mt-1 text-sm text-gray-500">Este link não existe ou foi desativado.</p>
        </div>
      </div>
    );
  return <CheckoutView checkout={data} />;
}

function Countdown({ minutes }: { minutes: number }) {
  const [left, setLeft] = useState(() => {
    const key = `ck_timer_${location.pathname}`;
    try {
      const saved = Number(sessionStorage.getItem(key));
      if (saved > Date.now()) return Math.round((saved - Date.now()) / 1000);
      sessionStorage.setItem(key, String(Date.now() + minutes * 60000));
    } catch {
      /* ignore */
    }
    return minutes * 60;
  });
  useEffect(() => {
    const t = setInterval(() => setLeft((l) => Math.max(0, l - 1)), 1000);
    return () => clearInterval(t);
  }, []);
  if (left <= 0) return null;
  const mm = String(Math.floor(left / 60)).padStart(2, '0');
  const ss = String(left % 60).padStart(2, '0');
  return (
    <div className="bg-brand text-brand-fg">
      <div className="mx-auto flex max-w-6xl items-center justify-center gap-2 px-4 py-2 text-sm font-medium">
        <Clock className="h-4 w-4" /> Oferta reservada por <span className="font-bold tabular-nums">{mm}:{ss}</span>
      </div>
    </div>
  );
}

function CheckoutView({ checkout }: { checkout: PublicCheckout }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const t = checkout.theme ?? {};
  const [bumps, setBumps] = useState<string[]>([]);
  const [couponInput, setCouponInput] = useState('');
  const [coupon, setCoupon] = useState<{ code: string; discount: number } | null>(null);
  const [couponMsg, setCouponMsg] = useState<string | null>(null);
  const [couponOpen, setCouponOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const startedRef = useRef(false);
  const eventIds = useMemo(() => ({ ic: `ic_${crypto.randomUUID()}`, purchase: `purchase_${crypto.randomUUID()}` }), []);

  const schema = useMemo(() => makeSchema(checkout.fields), [checkout.fields]);
  const { register, handleSubmit, setValue, formState, watch, reset } = useForm<FormValues>({
    resolver: zodResolver(schema),
    mode: 'onTouched',
    defaultValues: { name: '', email: '', phone: '', document: '' },
  });

  useEffect(() => {
    document.title = `${checkout.product.name} — Pagamento seguro`;
    initMetaPixel(checkout.tracking.metaPixelId);
    track(checkout.slug, 'page_view');
    const recover = params.get('recover');
    if (recover && /^[a-f0-9]{48}$/.test(recover)) {
      publicApi
        .get<{ customer: { name: string; email: string; phone: string | null } | null }>(`/orders/${recover}`)
        .then((o) => o.customer && reset({ name: o.customer.name, email: o.customer.email, phone: maskPhone(o.customer.phone ?? ''), document: '' }))
        .catch(() => {});
    }
  }, [checkout, params, reset]);

  const values = watch();
  useEffect(() => {
    if (!startedRef.current && (values.email || values.name)) {
      startedRef.current = true;
      track(checkout.slug, 'initiate_checkout');
      pixel('InitiateCheckout', { value: checkout.price_cents / 100, currency: 'BRL', content_name: checkout.product.name }, eventIds.ic);
    }
  }, [values.email, values.name, checkout, eventIds.ic]);

  const selectedBumps = checkout.bumps.filter((b) => bumps.includes(b.id));
  const subtotal = checkout.price_cents + selectedBumps.reduce((s, b) => s + b.price_cents, 0);
  const discount = coupon ? Math.min(coupon.discount, subtotal - 1) : 0;
  const total = subtotal - discount;

  const quote = useMutation({
    mutationFn: (p: { code: string; bump_ids: string[] }) =>
      publicApi.post<{ discount_cents: number; coupon: { code: string } | null; coupon_error: string | null }>(`/checkouts/${checkout.slug}/quote`, {
        bump_ids: p.bump_ids,
        coupon_code: p.code,
      }),
  });

  async function applyCoupon(code = couponInput, bumpIds = bumps) {
    const c = code.trim().toUpperCase();
    if (!c) return;
    setCouponMsg(null);
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
    const next = bumps.includes(id) ? bumps.filter((b) => b !== id) : [...bumps, id];
    setBumps(next);
    track(checkout.slug, bumps.includes(id) ? 'remove_bump' : 'add_bump', { bump_id: id });
    if (coupon) applyCoupon(coupon.code, next); // recalcula desconto percentual
  }

  const submit = useMutation({
    mutationFn: (v: FormValues) =>
      publicApi.post<{ token: string }>('/orders', {
        checkout_slug: checkout.slug,
        customer: { name: v.name, email: v.email, phone: v.phone ? digits(v.phone) : null, document: v.document ? digits(v.document) : null },
        bump_ids: bumps,
        coupon_code: coupon?.code ?? null,
        tracking: { ...collectTracking(), initiate_checkout_event_id: eventIds.ic, purchase_event_id: eventIds.purchase },
      }),
    onSuccess: (r) => navigate(`/pedido/${r.token}`),
    onError: (e) => setServerError(e instanceof ApiError ? e.message : 'Não foi possível gerar o PIX. Tente novamente.'),
  });

  const err = formState.errors;
  const banner = t.bannerUrl || t.mockupUrl || checkout.product.image_url;
  const guaranteeDays = t.guaranteeDays ?? 7;

  const summary = (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        {checkout.product.image_url && <img src={checkout.product.image_url} alt="" className="h-14 w-14 shrink-0 rounded-xl object-cover" />}
        <div className="min-w-0 flex-1">
          <p className="font-medium leading-snug text-gray-900">{checkout.product.name}</p>
          <p className="text-xs text-gray-500">Acesso digital imediato</p>
        </div>
        <p className="font-semibold tabular-nums">{brl(checkout.price_cents)}</p>
      </div>
      {selectedBumps.map((b) => (
        <div key={b.id} className="animate-fade-in flex items-center justify-between text-sm">
          <span className="flex items-center gap-1.5 text-gray-700">
            <Zap className="h-3.5 w-3.5 text-brand" /> {b.title}
          </span>
          <span className="tabular-nums">{brl(b.price_cents)}</span>
        </div>
      ))}

      <div className="border-t border-dashed border-gray-200 pt-3">
        {!couponOpen && !coupon ? (
          <button type="button" onClick={() => setCouponOpen(true)} className="flex items-center gap-1.5 text-sm font-medium text-brand hover:underline">
            <Tag className="h-4 w-4" /> Tenho um cupom de desconto
          </button>
        ) : coupon ? (
          <div className="flex items-center justify-between rounded-xl bg-emerald-50 px-3 py-2 text-sm">
            <span className="flex items-center gap-1.5 font-medium text-emerald-700">
              <Check className="h-4 w-4" /> Cupom {coupon.code} aplicado
            </span>
            <button type="button" className="text-xs text-emerald-700 underline" onClick={() => (setCoupon(null), setCouponInput(''))}>
              remover
            </button>
          </div>
        ) : (
          <div>
            <div className="flex gap-2">
              <Input
                value={couponInput}
                onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), applyCoupon())}
                placeholder="Código do cupom"
                autoCapitalize="characters"
                className="h-11"
              />
              <Button type="button" variant="secondary" className="h-11 shrink-0" loading={quote.isPending} onClick={() => applyCoupon()}>
                Aplicar
              </Button>
            </div>
            {couponMsg && <p className="mt-1.5 text-xs font-medium text-red-600">{couponMsg}</p>}
          </div>
        )}
      </div>

      <div className="space-y-1.5 border-t border-gray-100 pt-3 text-sm">
        <div className="flex justify-between text-gray-600">
          <span>Subtotal</span>
          <span className="tabular-nums">{brl(subtotal)}</span>
        </div>
        {discount > 0 && (
          <div className="flex justify-between text-emerald-700">
            <span>Desconto</span>
            <span className="tabular-nums">−{brl(discount)}</span>
          </div>
        )}
        <div className="flex items-end justify-between pt-1">
          <span className="font-semibold">Total</span>
          <span className="text-2xl font-bold tabular-nums tracking-tight">{brl(total)}</span>
        </div>
      </div>
    </div>
  );

  return (
    <div style={themeStyle(t)} className="min-h-screen">
      {t.showTimer && <Countdown minutes={t.timerMinutes ?? 15} />}

      <header className="border-b border-black/5 bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          {t.logoUrl ? <img src={t.logoUrl} alt={checkout.store.name} className="h-8 w-auto max-w-[160px] object-contain" /> : <span className="font-semibold">{checkout.store.name}</span>}
          <span className="flex items-center gap-1.5 text-xs font-medium text-gray-600">
            <Lock className="h-3.5 w-3.5 text-emerald-600" /> Pagamento 100% seguro
          </span>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-5 px-4 py-5 md:py-8 lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-8">
        {/* Coluna direita no desktop / topo no mobile: banner */}
        {banner && (
          <div className="lg:col-start-2 lg:row-start-1">
            <img src={banner} alt={checkout.product.name} className="aspect-[16/9] w-full rounded-2xl object-cover shadow-sm lg:aspect-[4/3]" fetchPriority="high" />
          </div>
        )}

        {/* Coluna esquerda: formulário */}
        <form
          noValidate
          onSubmit={handleSubmit((v) => (setServerError(null), submit.mutate(v)))}
          className="space-y-5 lg:col-start-1 lg:row-span-3 lg:row-start-1"
        >
          <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
            <p className="text-xs font-semibold uppercase tracking-wider text-brand">Você está adquirindo</p>
            <h1 className="mt-1 text-xl font-bold leading-tight tracking-tight sm:text-2xl">{t.headline || checkout.product.name}</h1>
            {checkout.product.description && <p className="mt-2 text-sm leading-relaxed text-gray-600">{checkout.product.description}</p>}
          </section>

          <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
            <h2 className="mb-4 flex items-center gap-2 font-semibold">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand text-xs text-brand-fg">1</span> Seus dados
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nome completo" error={err.name?.message} className="sm:col-span-2">
                <Input {...register('name')} icon={<User className="h-4 w-4" />} autoComplete="name" placeholder="Como no seu documento" invalid={!!err.name} enterKeyHint="next" />
              </Field>
              <Field label="E-mail" error={err.email?.message} hint="O acesso será enviado para este e-mail" className="sm:col-span-2">
                <Input {...register('email')} icon={<Mail className="h-4 w-4" />} type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} placeholder="voce@email.com" invalid={!!err.email} enterKeyHint="next" />
              </Field>
              {checkout.fields.phone && (
                <Field label="Celular / WhatsApp" error={err.phone?.message}>
                  <Input
                    {...register('phone')}
                    icon={<Phone className="h-4 w-4" />}
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel-national"
                    placeholder="(11) 99999-9999"
                    invalid={!!err.phone}
                    onChange={(e) => setValue('phone', maskPhone(e.target.value), { shouldValidate: formState.isSubmitted })}
                  />
                </Field>
              )}
              {checkout.fields.document && (
                <Field label="CPF ou CNPJ" error={err.document?.message}>
                  <Input
                    {...register('document')}
                    icon={<BadgeCheck className="h-4 w-4" />}
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="000.000.000-00"
                    invalid={!!err.document}
                    onChange={(e) => setValue('document', maskDocument(e.target.value), { shouldValidate: formState.isSubmitted })}
                  />
                </Field>
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm sm:p-6">
            <h2 className="mb-4 flex items-center gap-2 font-semibold">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand text-xs text-brand-fg">2</span> Pagamento
            </h2>
            <div className="flex items-center gap-3 rounded-xl border-2 border-brand bg-brand/5 p-4">
              <PixIcon className="h-7 w-7 shrink-0" />
              <div className="flex-1">
                <p className="font-semibold">PIX</p>
                <p className="text-xs text-gray-600">Aprovação imediata · Acesso liberado na hora</p>
              </div>
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand text-brand-fg">
                <Check className="h-3.5 w-3.5" />
              </span>
            </div>
          </section>

          {checkout.bumps.length > 0 && (
            <section className="space-y-3">
              <p className="px-1 text-sm font-semibold text-gray-800">Aproveite também — oferta exclusiva desta página</p>
              {checkout.bumps.map((b) => {
                const on = bumps.includes(b.id);
                return (
                  <button
                    type="button"
                    key={b.id}
                    onClick={() => toggleBump(b.id)}
                    aria-pressed={on}
                    className={cn(
                      'block w-full rounded-2xl border-2 border-dashed bg-white p-4 text-left transition brand-ring',
                      on ? 'border-brand bg-brand/5 shadow-sm' : 'border-gray-300 hover:border-gray-400',
                    )}
                  >
                    <div className="flex gap-3">
                      <span className={cn('mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 transition', on ? 'border-brand bg-brand text-brand-fg' : 'border-gray-300 bg-white')}>
                        {on && <Check className="h-4 w-4" />}
                      </span>
                      {b.image_url && <img src={b.image_url} alt="" className="h-16 w-16 shrink-0 rounded-lg object-cover" loading="lazy" />}
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold leading-snug">{b.title}</p>
                        {b.description && <p className="mt-1 text-sm leading-relaxed text-gray-600">{b.description}</p>}
                        <p className="mt-2 text-sm">
                          {b.compare_at_cents ? <span className="mr-2 text-gray-400 line-through">{brl(b.compare_at_cents)}</span> : null}
                          <span className="font-bold text-brand">+ {brl(b.price_cents)}</span>
                        </p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </section>
          )}

          {/* Resumo no mobile (acima do botão) */}
          <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm lg:hidden">
            <h2 className="mb-4 font-semibold">Resumo do pedido</h2>
            {summary}
          </section>

          {serverError && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{serverError}</div>}

          <div className="space-y-3">
            <Button type="submit" variant="brand" size="lg" className="w-full text-base" loading={submit.isPending}>
              {submit.isPending ? 'Gerando PIX…' : (
                <>
                  <Lock className="h-4 w-4" /> {t.buttonText || 'Pagar com PIX'} · {brl(total)}
                </>
              )}
            </Button>
            <p className="flex items-center justify-center gap-1.5 text-center text-xs text-gray-500">
              <ShieldCheck className="h-3.5 w-3.5" /> Seus dados são protegidos e não são compartilhados.
            </p>
          </div>
        </form>

        {/* Coluna direita: resumo + garantia */}
        <aside className={cn('space-y-5 lg:col-start-2', banner ? 'lg:row-start-2' : 'lg:row-start-1')}>
          <section className="hidden rounded-2xl border border-gray-200 bg-white p-5 shadow-sm lg:block">
            <h2 className="mb-4 font-semibold">Resumo do pedido</h2>
            {summary}
          </section>

          <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="space-y-4 text-sm">
              {guaranteeDays > 0 && (
                <div className="flex gap-3">
                  <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-600" />
                  <div>
                    <p className="font-semibold">Garantia de {guaranteeDays} dias</p>
                    <p className="text-gray-600">{t.guaranteeText || 'Se não gostar, devolvemos 100% do seu dinheiro. Sem perguntas.'}</p>
                  </div>
                </div>
              )}
              <div className="flex gap-3">
                <Zap className="h-5 w-5 shrink-0 text-amber-500" />
                <div>
                  <p className="font-semibold">Acesso imediato</p>
                  <p className="text-gray-600">Receba no seu e-mail assim que o PIX for confirmado.</p>
                </div>
              </div>
              <div className="flex gap-3">
                <Lock className="h-5 w-5 shrink-0 text-gray-700" />
                <div>
                  <p className="font-semibold">Compra segura</p>
                  <p className="text-gray-600">Conexão criptografada (SSL) e pagamento processado por instituição autorizada pelo Banco Central.</p>
                </div>
              </div>
            </div>
          </section>

          {(t.testimonials?.length ?? 0) > 0 && (
            <section className="space-y-3">
              {t.testimonials!.map((tm, i) => (
                <figure key={i} className="rounded-2xl border border-gray-200 bg-white p-4 text-sm shadow-sm">
                  <blockquote className="text-gray-700">“{tm.text}”</blockquote>
                  <figcaption className="mt-3 flex items-center gap-2 font-medium">
                    {tm.avatarUrl ? <img src={tm.avatarUrl} alt="" className="h-7 w-7 rounded-full object-cover" loading="lazy" /> : <span className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-100 text-xs">{tm.name[0]}</span>}
                    {tm.name}
                  </figcaption>
                </figure>
              ))}
            </section>
          )}
        </aside>
      </main>

      <footer className="mx-auto max-w-6xl px-4 pb-10 pt-2 text-center text-xs leading-relaxed text-gray-500">
        {t.footerText && <p className="mb-1">{t.footerText}</p>}
        <p>
          {checkout.store.name}
          {checkout.store.document && ` · ${checkout.store.document}`}
          {checkout.store.supportEmail && (
            <>
              {' · '}
              <a className="underline" href={`mailto:${checkout.store.supportEmail}`}>
                {checkout.store.supportEmail}
              </a>
            </>
          )}
        </p>
      </footer>
    </div>
  );
}

export function PixIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" className={className} aria-hidden>
      <path fill="#32BCAD" d="M242.4 292.5a32.7 32.7 0 0 1 46.2 0l69.9 69.9a63.9 63.9 0 0 0 45.5 18.8h13.7L329.4 469.5a70.6 70.6 0 0 1-99.8 0l-88.6-88.6h7.9a63.9 63.9 0 0 0 45.5-18.8zm46.2-73a32.7 32.7 0 0 1-46.2 0l-48.7-48.7a63.9 63.9 0 0 0-45.5-18.8h-7.9l88.5-88.5a70.6 70.6 0 0 1 99.8 0l88.3 88.3h-13.7a63.9 63.9 0 0 0-45.5 18.8zM163 172.9a43 43 0 0 1 30.4 12.6l48.7 48.7a22.7 22.7 0 0 0 32.1 0l69.9-69.9a43 43 0 0 1 30.4-12.6h34.5l53.6 53.6a70.6 70.6 0 0 1 0 99.8l-53.6 53.6h-34.5a43 43 0 0 1-30.4-12.6l-69.9-69.9a23.3 23.3 0 0 0-32.1 0l-48.7 48.7A43 43 0 0 1 163 337.6h-42.6l-53.3-53.3a70.6 70.6 0 0 1 0-99.8l53.3-53.3z" />
    </svg>
  );
}
