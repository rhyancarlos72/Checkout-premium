import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, Copy, ExternalLink, Lock, Play, QrCode, Repeat, ShieldCheck, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, publicApi } from '@/lib/api';
import { brl, digits, isValidCpf, maskDocument, maskPhone, nationalPhone } from '@/lib/format';
import { collectTracking, initMetaPixel, pixel, setPixelUser, track, visitorExternalId } from '@/lib/tracking';

/**
 * Página de vendas de upsell (/oferta/:slug): título + vídeo (VSL) + botão.
 * O pagamento acontece AQUI MESMO: abre um painel com os dados (já preenchidos quando a pessoa veio do link do
 * áudio ou de um pedido pago), mostra o Pix e, quando cai, libera o botão da área de membros.
 */
interface Offer {
  slug: string;
  headline: string;
  subheadline: string | null;
  video: { hd: string; sd: string | null; poster: string | null } | null;
  poster: string | null;
  cta_text: string;
  bullets: string[];
  guarantee: string | null;
  button_delay_seconds: number;
  checkout_slug: string;
  checkout: {
    slug: string;
    price_cents: number;
    tracking: { metaPixelId: string | null };
    product: { name: string; number: number | null };
    store: { name: string | null; supportEmail: string | null; document: string | null };
    club: { monthly_cents: number; plan: string | null; auto: boolean } | null;
  };
}
interface Order {
  status: string;
  total_cents: number;
  pix_code: string | null;
  pix_qr_image: string | null;
  expires_at: string | null;
  items: { kind: string; name: string; price_cents: number }[];
  content_ids?: string[];
  external_id?: string | null;
  customer?: { name: string; email: string; phone: string | null } | null;
  purchase_event_id: string | null;
  content_category?: string | null;
  audio_id?: string | null;
  delivery: { name: string; url: string | null; note: string | null }[];
  subscription?: { auto: boolean; authorized: boolean; paid_until: string | null; monthly_cents: number } | null;
}

function embedded(slug: string | undefined): Offer | undefined {
  try {
    const raw = JSON.parse(document.getElementById('ck-offer')?.textContent || 'null');
    return raw && raw.slug === slug ? raw.data : undefined;
  } catch {
    return undefined;
  }
}

/** Internet fraca ou economia de dados: usa a versão 480p do vídeo. */
function slowNetwork() {
  const c = (navigator as any).connection;
  return Boolean(c?.saveData || /(^|-)2g|3g/.test(String(c?.effectiveType ?? '')));
}

export default function OfferPage() {
  const { slug } = useParams();
  const { data: offer, isLoading, error } = useQuery({
    queryKey: ['offer', slug],
    queryFn: () => publicApi.get<Offer>(`/offers/${slug}`),
    initialData: () => embedded(slug),
    staleTime: 60_000,
  });
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const prefill = useQuery({
    queryKey: ['offer-prefill', slug],
    enabled: Boolean(params.get('wa') || params.get('o')),
    queryFn: () => publicApi.get<{ customer: { name: string; email: string; phone: string } | null }>(`/offers/${slug}/prefill?${new URLSearchParams({ wa: params.get('wa') ?? '', o: params.get('o') ?? '' })}`),
    staleTime: Infinity,
  });

  const [open, setOpen] = useState(false);
  const [unlocked, setUnlocked] = useState(false); // botão liberado (vídeo passou do tempo escolhido)
  const viewed = useRef(false);

  useEffect(() => {
    if (!offer || viewed.current) return;
    viewed.current = true;
    initMetaPixel(offer.checkout.tracking.metaPixelId, { externalId: visitorExternalId() });
    pixel('ViewContent', { value: offer.checkout.price_cents / 100, currency: 'BRL', content_name: offer.checkout.product.name, content_type: 'product' });
    collectTracking(); // guarda UTMs / wa do link do áudio
    try {
      const k = `ck_offer_view_${offer.slug}`;
      if (!sessionStorage.getItem(k)) {
        sessionStorage.setItem(k, '1');
        track(offer.checkout_slug, 'offer_view', { offer: offer.slug });
      }
    } catch {
      track(offer.checkout_slug, 'offer_view', { offer: offer.slug });
    }
    try {
      if (localStorage.getItem(`ck_offer_btn_${offer.slug}`)) setUnlocked(true);
    } catch {
      /* ignore */
    }
  }, [offer]);

  if (isLoading) return <div className="flex min-h-screen items-center justify-center bg-[#0b0d12]"><span className="h-8 w-8 animate-spin rounded-full border-[3px] border-white/20 border-t-white" /></div>;
  if (error || !offer) return <div className="flex min-h-screen items-center justify-center bg-[#0b0d12] p-6 text-center text-white/70">Esta oferta não está mais disponível.</div>;

  const club = offer.checkout.club;
  const price = club ? club.monthly_cents : offer.checkout.price_cents;
  const showButton = unlocked || !offer.button_delay_seconds || !offer.video;
  const unlock = () => {
    setUnlocked(true);
    try {
      localStorage.setItem(`ck_offer_btn_${offer.slug}`, '1');
    } catch {
      /* ignore */
    }
  };
  const openSheet = () => {
    setOpen(true);
    track(offer.checkout_slug, 'offer_click', { offer: offer.slug });
    pixel('InitiateCheckout', { value: price / 100, currency: 'BRL', content_name: offer.checkout.product.name, content_type: 'product', num_items: 1 });
  };

  return (
    <div className="min-h-screen bg-[#0b0d12] text-white">
      <main className="mx-auto flex max-w-[760px] flex-col items-center px-4 pb-16 pt-8 text-center sm:pt-12">
        <h1 className="text-balance text-[26px] font-extrabold leading-tight tracking-tight sm:text-[38px]">{offer.headline}</h1>
        {offer.subheadline && <p className="mt-3 max-w-[600px] text-balance text-[15px] text-white/70 sm:text-lg">{offer.subheadline}</p>}

        {offer.video && <Vsl offer={offer} onReach={offer.button_delay_seconds ? unlock : undefined} />}
        {!offer.video && offer.poster && <img src={offer.poster} alt="" className="mt-6 w-full rounded-2xl" fetchPriority="high" />}

        {showButton ? (
          <div className="animate-fade-in mt-7 w-full max-w-[460px]">
            <button type="button" onClick={openSheet} className="w-full rounded-2xl bg-emerald-500 px-6 py-4 text-lg font-extrabold text-white shadow-[0_10px_30px_-8px_rgba(16,185,129,.6)] transition hover:bg-emerald-400 active:scale-[.99]">
              {offer.cta_text}
            </button>
            <p className="mt-3 text-sm text-white/70">
              {club ? <><b className="text-white">{brl(price)}/mês</b>{club.plan ? ` · Plano ${club.plan}` : ''} · cancele quando quiser</> : <b className="text-white">{brl(price)}</b>}
            </p>
            <p className="mt-2 flex items-center justify-center gap-1.5 text-xs text-white/50"><Lock className="h-3.5 w-3.5" /> Pagamento seguro via Pix · acesso imediato</p>
          </div>
        ) : (
          <p className="mt-6 text-sm text-white/50">Assista ao vídeo: o botão para entrar aparece logo abaixo.</p>
        )}

        {offer.bullets.length > 0 && (
          <ul className="mt-8 grid w-full max-w-[520px] gap-2.5 text-left">
            {offer.bullets.map((b, i) => (
              <li key={i} className="flex items-start gap-2.5 rounded-xl bg-white/[.04] px-4 py-3 text-[15px] ring-1 ring-white/[.06]">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" strokeWidth={3} /> {b}
              </li>
            ))}
          </ul>
        )}
        {offer.guarantee && <p className="mt-6 flex max-w-[520px] items-center gap-2 text-left text-sm text-white/60"><ShieldCheck className="h-5 w-5 shrink-0 text-emerald-400" /> {offer.guarantee}</p>}
        {offer.checkout.store.name && <p className="mt-10 text-xs text-white/35">{offer.checkout.store.name}{offer.checkout.store.document ? ` · ${offer.checkout.store.document}` : ''}</p>}
      </main>
      {open && <PaySheet offer={offer} price={price} prefill={prefill.data?.customer ?? null} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** Vídeo: só a capa aparece de início; o vídeo carrega ao tocar (ou depois que a página terminou de abrir). */
function Vsl({ offer, onReach }: { offer: Offer; onReach?: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);
  const src = offer.video!.sd && slowNetwork() ? offer.video!.sd : offer.video!.hd;
  useEffect(() => {
    // página aberta: deixa o navegador buscar só o comecinho do vídeo (sem competir com o carregamento da página)
    const t = window.setTimeout(() => ref.current && ref.current.preload === 'none' && (ref.current.preload = 'metadata'), 2500);
    return () => window.clearTimeout(t);
  }, []);
  const onTime = () => {
    if (onReach && ref.current && ref.current.currentTime >= offer.button_delay_seconds) onReach();
  };
  return (
    <div className="relative mt-6 w-full overflow-hidden rounded-2xl bg-black shadow-2xl ring-1 ring-white/10">
      <video
        ref={ref}
        className="aspect-video w-full bg-black"
        src={src}
        poster={offer.video!.poster ?? undefined}
        preload="none"
        playsInline
        controls={started}
        controlsList="nodownload"
        onTimeUpdate={onTime}
        onPlay={() => setStarted(true)}
      />
      {!started && (
        <button
          type="button"
          aria-label="Assistir ao vídeo"
          onClick={() => {
            setStarted(true);
            void ref.current?.play();
          }}
          className="absolute inset-0 flex items-center justify-center bg-black/25 transition hover:bg-black/15"
        >
          <span className="flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500 shadow-[0_0_0_10px_rgba(16,185,129,.25)]">
            <Play className="ml-1 h-9 w-9 fill-white text-white" />
          </span>
        </button>
      )}
    </div>
  );
}

/** Painel de pagamento: dados → Pix na própria página → acesso liberado. */
function PaySheet({ offer, price, prefill, onClose }: { offer: Offer; price: number; prefill: { name: string; email: string; phone: string } | null; onClose: () => void }) {
  const club = offer.checkout.club;
  const needCpf = Boolean(club?.auto);
  const [v, setV] = useState({ name: prefill?.name ?? '', email: prefill?.email ?? '', phone: prefill?.phone ? maskPhone(prefill.phone) : '', document: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const fired = useRef(false);

  useEffect(() => {
    if (prefill) setV((x) => ({ ...x, name: x.name || prefill.name, email: x.email || prefill.email, phone: x.phone || (prefill.phone ? maskPhone(prefill.phone) : '') }));
  }, [prefill]);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => void (document.body.style.overflow = prev);
  }, []);

  const create = useMutation({
    mutationFn: () =>
      publicApi.post<{ token: string; order: Order }>('/orders', {
        checkout_slug: offer.checkout_slug,
        customer: { name: v.name.trim(), email: v.email.trim(), phone: nationalPhone(v.phone), document: needCpf ? digits(v.document) : null },
        bump_ids: [],
        tracking: { ...collectTracking(), offer: offer.slug },
      }),
    onSuccess: (r) => setToken(r.token),
  });
  const order = useQuery({
    queryKey: ['offer-order', token],
    enabled: Boolean(token),
    initialData: () => create.data?.order,
    queryFn: () => publicApi.get<Order>(`/orders/${token}`),
    refetchInterval: (q) => (q.state.data?.status === 'pending' ? 4000 : false),
    refetchIntervalInBackground: true,
  });
  const o = order.data;

  // Purchase no Pixel (mesmo event_id do servidor → a Meta deduplica)
  useEffect(() => {
    if (o?.status !== 'paid' || fired.current || !token) return;
    fired.current = true;
    try {
      if (localStorage.getItem(`ck_purchase_${token}`)) return;
      localStorage.setItem(`ck_purchase_${token}`, '1');
    } catch {
      /* ignore */
    }
    pixel('Purchase', { value: o.total_cents / 100, currency: 'BRL', content_type: 'product', content_ids: o.content_ids ?? [], num_items: o.items.length, ...(o.content_category ? { content_category: o.content_category, audio_id: o.audio_id ?? undefined } : {}) }, o.purchase_event_id ?? undefined);
  }, [o?.status, token]); // eslint-disable-line react-hooks/exhaustive-deps

  function submit(e: FormEvent) {
    e.preventDefault();
    const err: Record<string, string> = {};
    if (v.name.trim().split(/\s+/).length < 2) err.name = 'Informe seu nome completo';
    if (!/^\S+@\S+\.\S{2,}$/.test(v.email.trim())) err.email = 'E-mail inválido';
    if (digits(v.phone).length < 10) err.phone = 'Informe seu WhatsApp com DDD';
    if (needCpf && !isValidCpf(v.document)) err.document = 'CPF inválido';
    setErrors(err);
    if (Object.keys(err).length) return;
    setPixelUser(offer.checkout.tracking.metaPixelId, { email: v.email, phone: v.phone, name: v.name, externalId: visitorExternalId() });
    pixel('AddPaymentInfo', { value: price / 100, currency: 'BRL', content_type: 'product', payment_type: 'pix' });
    create.mutate();
  }
  async function copy() {
    if (!o?.pix_code) return;
    try {
      await navigator.clipboard.writeText(o.pix_code);
    } catch {
      const ta = Object.assign(document.createElement('textarea'), { value: o.pix_code });
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
    track(offer.checkout_slug, 'pix_copied', { offer: offer.slug });
  }

  const input = 'h-12 w-full rounded-xl border border-zinc-300 bg-white px-3.5 text-[16px] text-zinc-900 outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/15';
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="Pagamento">
      <div className="animate-fade-in max-h-[92vh] w-full max-w-[460px] overflow-y-auto rounded-t-3xl bg-white p-5 text-left text-zinc-900 shadow-2xl sm:rounded-3xl sm:p-6">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-600">{o?.status === 'paid' ? 'Tudo certo' : 'Falta pouco'}</p>
            <h2 className="text-lg font-bold leading-snug">{offer.checkout.product.name}</h2>
            <p className="text-sm text-zinc-500">{club ? `${brl(price)}/mês${club.plan ? ` · Plano ${club.plan}` : ''}` : brl(price)}</p>
          </div>
          {o?.status !== 'paid' && (
            <button type="button" onClick={onClose} aria-label="Fechar" className="rounded-full p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"><X className="h-5 w-5" /></button>
          )}
        </div>

        {!o && (
          <form onSubmit={submit} className="space-y-3" noValidate>
            <Field label="Nome completo" error={errors.name}><input className={input} autoComplete="name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
            <Field label="E-mail" error={errors.email}><input className={input} type="email" inputMode="email" autoComplete="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} /></Field>
            <Field label="WhatsApp" error={errors.phone}><input className={input} inputMode="tel" autoComplete="tel" value={v.phone} onChange={(e) => setV({ ...v, phone: maskPhone(e.target.value) })} placeholder="(11) 99999-9999" /></Field>
            {needCpf && (
              <Field label="CPF (para o Pix Automático)" error={errors.document}><input className={input} inputMode="numeric" value={v.document} onChange={(e) => setV({ ...v, document: maskDocument(e.target.value) })} placeholder="000.000.000-00" /></Field>
            )}
            {create.error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{create.error instanceof ApiError ? create.error.message : 'Não foi possível gerar o Pix. Tente de novo.'}</p>}
            <button type="submit" disabled={create.isPending} className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-emerald-500 text-[17px] font-extrabold text-white transition hover:bg-emerald-400 disabled:opacity-70">
              {create.isPending ? <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <QrCode className="h-5 w-5" />} {create.isPending ? 'Gerando seu Pix…' : 'Pagar com Pix'}
            </button>
            {club?.auto && <p className="flex items-start gap-1.5 text-xs text-zinc-500"><Repeat className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Ao pagar, o app do banco pede para autorizar o Pix Automático: confirme para renovar sozinho todo mês. Cancele quando quiser.</p>}
          </form>
        )}

        {o && o.status !== 'paid' && (
          <div className="text-center">
            {o.pix_qr_image && <img src={o.pix_qr_image} alt="QR Code Pix" className="mx-auto h-52 w-52 rounded-xl border border-zinc-200 p-2" />}
            <p className="mt-3 text-sm text-zinc-600">Abra o app do seu banco e escaneie o QR Code, ou copie o código:</p>
            <button type="button" onClick={copy} className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl bg-emerald-500 py-3.5 text-[16px] font-extrabold text-white transition hover:bg-emerald-400">
              {copied ? <Check className="h-5 w-5" /> : <Copy className="h-5 w-5" />} {copied ? 'Código copiado!' : 'Copiar código Pix'}
            </button>
            <p className="mt-2 break-all rounded-lg bg-zinc-50 px-3 py-2 text-left font-mono text-[11px] leading-snug text-zinc-500">{o.pix_code}</p>
            <p className="mt-4 flex items-center justify-center gap-2 text-sm font-medium text-zinc-700"><span className="h-2.5 w-2.5 animate-pulse rounded-full bg-amber-400" /> Aguardando o pagamento… a tela muda sozinha.</p>
          </div>
        )}

        {o?.status === 'paid' && (
          <div className="text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500 shadow-lg shadow-emerald-500/30"><Check className="h-8 w-8 text-white" strokeWidth={3} /></div>
            <h3 className="mt-3 text-xl font-bold">Pagamento aprovado!</h3>
            <p className="mt-1 text-sm text-zinc-600">Seu acesso já está liberado. Também enviamos os dados para {o.customer?.email}.</p>
            {o.subscription?.paid_until && <p className="mt-2 text-xs text-zinc-500">Assinatura ativa até {new Date(o.subscription.paid_until).toLocaleDateString('pt-BR')}{o.subscription.authorized ? ' · renova sozinha no Pix Automático' : ''}</p>}
            <div className="mt-4 space-y-2">
              {o.delivery.filter((d) => d.url).map((d, i) => (
                <a key={i} href={d.url!} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-emerald-500 py-3.5 text-[16px] font-extrabold text-white hover:bg-emerald-400">
                  {d.url!.includes('/membros') ? 'Entrar na área de membros' : `Acessar ${d.name}`} <ExternalLink className="h-4 w-4" />
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-zinc-700">{label}</span>
      {children}
      {error && <span className="mt-1 block text-xs font-medium text-red-600">{error}</span>}
    </label>
  );
}
