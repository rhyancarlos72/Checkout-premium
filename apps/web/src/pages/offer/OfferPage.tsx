import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, Copy, ExternalLink, Lock, Play, QrCode, Repeat, ShieldCheck, Volume2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, publicApi } from '@/lib/api';
import { brl, digits, isValidCpf, maskDocument, maskPhone, nationalPhone } from '@/lib/format';
import { collectTracking, initMetaPixel, pixel, setPixelUser, track, visitorExternalId } from '@/lib/tracking';

/**
 * Página de vendas de upsell (/oferta/:slug), formato VSL:
 *  faixa no topo → texto pequeno → TÍTULO → vídeo (começa sem som, "Clique para ouvir") → botão → benefícios.
 * O pagamento acontece AQUI MESMO. Quem veio de um pedido pago (?o=) ou do link do áudio (?wa=) compra em um toque.
 * "Não quero, obrigado" (só para quem veio de um pedido) volta para a página de acesso do material comprado.
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
  banner_text: string | null;
  pre_headline: string | null;
  decline_text: string;
  video_ratio: '16:9' | '9:16' | '1:1' | '4:5';
  accent_color: string;
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
  items: { kind: string; name: string; price_cents: number }[];
  content_ids?: string[];
  customer?: { name: string; email: string; phone: string | null } | null;
  purchase_event_id: string | null;
  content_category?: string | null;
  audio_id?: string | null;
  delivery: { name: string; url: string | null; note: string | null }[];
  subscription?: { auto: boolean; authorized: boolean; paid_until: string | null; monthly_cents: number } | null;
}
type Prefill = { name: string; email: string; phone: string; has_document: boolean };
/** última chamada (link do áudio ainda válido): 1º mês com desconto */
type Discount = { first_cents: number; until: string };

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
const RATIO: Record<Offer['video_ratio'], { aspect: string; max: string }> = {
  '9:16': { aspect: '9 / 16', max: 'min(100%, 380px, calc(68vh * 9 / 16))' },
  '4:5': { aspect: '4 / 5', max: 'min(100%, 460px)' },
  '1:1': { aspect: '1 / 1', max: 'min(100%, 520px)' },
  '16:9': { aspect: '16 / 9', max: '100%' },
};

export default function OfferPage() {
  const { slug } = useParams();
  const { data: offer, isLoading, error } = useQuery({
    queryKey: ['offer', slug],
    queryFn: () => publicApi.get<Offer>(`/offers/${slug}`),
    initialData: () => embedded(slug),
    staleTime: 60_000,
  });
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const from = { o: params.get('o') ?? '', wa: params.get('wa') ?? '' };
  const prefill = useQuery({
    queryKey: ['offer-prefill', slug],
    enabled: Boolean(from.o || from.wa),
    queryFn: () => publicApi.get<{ customer: Prefill | null; discount?: Discount | null }>(`/offers/${slug}/prefill?${new URLSearchParams(from)}`),
    staleTime: Infinity,
  });

  const [open, setOpen] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
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
      if (localStorage.getItem(`ck_offer_btn_${offer.slug}`)) setUnlocked(true);
    } catch {
      /* ignore */
    }
  }, [offer]);

  if (isLoading) return <div className="flex min-h-screen items-center justify-center bg-black"><span className="h-8 w-8 animate-spin rounded-full border-[3px] border-white/20 border-t-white" /></div>;
  if (error || !offer) return <div className="flex min-h-screen items-center justify-center bg-black p-6 text-center text-white/70">Esta oferta não está mais disponível.</div>;

  const club = offer.checkout.club;
  const normal = club ? club.monthly_cents : offer.checkout.price_cents;
  const discount = prefill.data?.discount && new Date(prefill.data.discount.until).getTime() > Date.now() && prefill.data.discount.first_cents < normal ? prefill.data.discount : null;
  const price = discount ? discount.first_cents : normal;
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
  const style = { '--accent': offer.accent_color } as CSSProperties;

  return (
    <div className="min-h-screen bg-black text-white" style={style}>
      {offer.banner_text && (
        <div className="offer-shine relative overflow-hidden py-2.5 text-center text-[13px] font-extrabold uppercase tracking-wide sm:text-sm" style={{ background: offer.accent_color }}>
          {offer.banner_text}
        </div>
      )}
      <main className="mx-auto flex max-w-[820px] flex-col items-center px-4 pb-16 pt-7 text-center sm:pt-10">
        {offer.pre_headline && <p className="text-[14px] font-semibold text-white/90 sm:text-base">{offer.pre_headline}</p>}
        <h1 className="mt-2 text-balance text-[25px] font-black uppercase leading-[1.12] tracking-tight sm:text-[38px]">{offer.headline}</h1>
        {offer.subheadline && <p className="mt-3 max-w-[620px] text-balance text-[15px] text-white/70 sm:text-lg">{offer.subheadline}</p>}

        {offer.video && <Vsl offer={offer} onReach={offer.button_delay_seconds ? unlock : undefined} />}
        {!offer.video && offer.poster && <img src={offer.poster} alt="" className="mt-6 w-full max-w-[640px] rounded-2xl" fetchPriority="high" />}

        {showButton ? (
          <div className="animate-fade-in mt-7 w-full max-w-[480px]">
            <button type="button" onClick={openSheet} className="animate-offer-cta w-full rounded-2xl px-6 py-[18px] text-[19px] font-black uppercase tracking-wide text-white shadow-[0_14px_36px_-10px_var(--accent)] transition hover:brightness-110 active:scale-[.98]" style={{ background: offer.accent_color }}>
              {offer.cta_text}
            </button>
            <p className="mt-3 text-[15px] text-white/80">
              {discount ? (
                <>
                  <span className="mr-1.5 text-white/45 line-through">{brl(normal)}</span>
                  <b className="text-[17px] text-white">1º mês por {brl(discount.first_cents)}</b>
                  <span className="block text-sm text-white/70">depois {brl(normal)}{club ? '/mês · cancele quando quiser' : ''}</span>
                </>
              ) : club ? <><b className="text-white">{brl(price)}/mês</b>{club.plan ? ` · Plano ${club.plan}` : ''} · cancele quando quiser</> : <>Por apenas <b className="text-white">{brl(price)}</b></>}
            </p>
            {discount && <p className="mt-2 inline-block rounded-full px-3 py-1 text-xs font-bold text-white" style={{ background: offer.accent_color }}>Condição válida até {new Date(discount.until).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', ' às')}</p>}
            <p className="mt-1.5 flex items-center justify-center gap-1.5 text-xs text-white/50"><Lock className="h-3.5 w-3.5" /> Pagamento seguro via Pix · acesso imediato</p>
          </div>
        ) : (
          <p className="mt-6 animate-pulse text-sm font-medium text-white/60">Assista ao vídeo: o botão para entrar aparece logo abaixo.</p>
        )}
        {from.o && /^[a-f0-9]{48}$/.test(from.o) && (
          <a href={`/pedido/${from.o}?upsell=nao`} className="mt-5 text-sm text-white/45 underline underline-offset-4 transition hover:text-white/80">{offer.decline_text}</a>
        )}

        {offer.bullets.length > 0 && (
          <ul className="mt-9 grid w-full max-w-[540px] gap-2.5 text-left">
            {offer.bullets.map((b, i) => (
              <li key={i} className="flex items-start gap-3 rounded-xl bg-white/[.05] px-4 py-3 text-[15px] ring-1 ring-white/[.07]">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full" style={{ background: offer.accent_color }}><Check className="h-3 w-3 text-white" strokeWidth={4} /></span> {b}
              </li>
            ))}
          </ul>
        )}
        {offer.guarantee && <p className="mt-6 flex max-w-[540px] items-center gap-2.5 text-left text-sm text-white/65"><ShieldCheck className="h-6 w-6 shrink-0" style={{ color: offer.accent_color }} /> {offer.guarantee}</p>}
        {offer.checkout.store.name && <p className="mt-10 text-xs text-white/30">{offer.checkout.store.name}{offer.checkout.store.document ? ` · ${offer.checkout.store.document}` : ''}</p>}
      </main>
      {open && <PaySheet offer={offer} price={price} normal={normal} discounted={Boolean(discount)} from={from} prefill={prefill.data?.customer ?? null} onClose={() => setOpen(false)} />}
    </div>
  );
}

/**
 * Vídeo no formato VSL: começa sozinho SEM som (depois que a página abriu, para não atrasar), com o botão
 * "Clique para ouvir". Ao tocar, volta para o início com som. Sem controles poluindo: toque pausa/continua
 * e uma barra fina mostra o andamento.
 */
function Vsl({ offer, onReach }: { offer: Offer; onReach?: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [withSound, setWithSound] = useState(false);
  const [paused, setPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const src = offer.video!.sd && slowNetwork() ? offer.video!.sd : offer.video!.hd;
  const r = RATIO[offer.video_ratio] ?? RATIO['16:9'];

  useEffect(() => {
    // prévia sem som só depois que a página terminou de abrir (o vídeo nunca atrasa o carregamento)
    const start = () => {
      const v = ref.current;
      if (!v || withSound) return;
      v.muted = true;
      v.preload = 'auto';
      void v.play().catch(() => {});
    };
    if (document.readyState === 'complete') {
      const t = window.setTimeout(start, 400);
      return () => window.clearTimeout(t);
    }
    window.addEventListener('load', start, { once: true });
    return () => window.removeEventListener('load', start);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const listen = () => {
    const v = ref.current;
    if (!v) return;
    setWithSound(true);
    v.loop = false;
    v.muted = false;
    v.currentTime = 0;
    void v.play().catch(() => {});
  };
  const toggle = () => {
    const v = ref.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };
  const onTime = () => {
    const v = ref.current;
    if (!v || !withSound) return;
    setProgress(v.duration ? v.currentTime / v.duration : 0);
    if (onReach && v.currentTime >= offer.button_delay_seconds) onReach();
  };

  return (
    <div className="relative mt-6 overflow-hidden rounded-2xl bg-zinc-900 shadow-[0_20px_60px_-20px_rgba(0,0,0,.9)] ring-1 ring-white/10" style={{ width: r.max, aspectRatio: r.aspect }}>
      <video
        ref={ref}
        className="h-full w-full object-cover"
        src={src}
        poster={offer.video!.poster ?? undefined}
        preload="none"
        playsInline
        muted
        loop
        controlsList="nodownload"
        disablePictureInPicture
        onTimeUpdate={onTime}
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        onEnded={() => setPaused(true)}
        onClick={withSound ? toggle : listen}
        onContextMenu={(e) => e.preventDefault()}
      />
      {!withSound && (
        <button type="button" aria-label="Clique para ouvir" onClick={listen} className="absolute inset-0 flex items-center justify-center bg-black/10">
          <span className="animate-offer-ring flex flex-col items-center gap-1.5 rounded-2xl px-6 py-4 shadow-2xl" style={{ background: offer.accent_color }}>
            <span className="text-[11px] font-bold uppercase tracking-wide text-white/90">Seu vídeo já começou</span>
            <span className="flex h-16 w-16 items-center justify-center rounded-full border-[5px] border-white">
              <Play className="ml-1 h-8 w-8 fill-white text-white" />
            </span>
            <span className="flex items-center gap-1 text-sm font-extrabold text-white"><Volume2 className="h-4 w-4" /> Clique para ouvir</span>
          </span>
        </button>
      )}
      {withSound && paused && (
        <button type="button" aria-label="Continuar o vídeo" onClick={toggle} className="absolute inset-0 flex items-center justify-center bg-black/35">
          <span className="flex h-20 w-20 items-center justify-center rounded-full shadow-2xl" style={{ background: offer.accent_color }}><Play className="ml-1 h-9 w-9 fill-white text-white" /></span>
        </button>
      )}
      {withSound && (
        <div className="absolute inset-x-0 bottom-0 h-1.5 bg-white/15">
          <div className="h-full transition-[width] duration-300 ease-linear" style={{ width: `${Math.round(progress * 1000) / 10}%`, background: offer.accent_color }} />
        </div>
      )}
    </div>
  );
}

/** Painel de pagamento: compra em um toque (cadastro conhecido) ou formulário → Pix na página → acesso liberado. */
function PaySheet({ offer, price, normal, discounted, from, prefill, onClose }: { offer: Offer; price: number; normal: number; discounted: boolean; from: { o: string; wa: string }; prefill: Prefill | null; onClose: () => void }) {
  const club = offer.checkout.club;
  const needCpf = Boolean(club?.auto);
  const [editing, setEditing] = useState(!prefill);
  const [v, setV] = useState({ name: prefill?.name ?? '', email: prefill?.email ?? '', phone: prefill?.phone ? maskPhone(prefill.phone) : '', document: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const fired = useRef(false);
  const accent = offer.accent_color;
  const oneTap = Boolean(prefill) && !editing;
  const askCpf = needCpf && (!oneTap || !prefill?.has_document);

  useEffect(() => {
    if (!prefill) return;
    setEditing(false);
    setV((x) => ({ ...x, name: x.name || prefill.name, email: x.email || prefill.email, phone: x.phone || (prefill.phone ? maskPhone(prefill.phone) : '') }));
  }, [prefill]);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => void (document.body.style.overflow = prev);
  }, []);

  const create = useMutation({
    mutationFn: () => {
      const tracking = { ...collectTracking(), offer: offer.slug };
      // sempre pela página: o servidor confere o link (desconto da última chamada) e usa o cadastro de quem veio do pedido/áudio
      return publicApi.post<{ token: string; order: Order }>(`/offers/${offer.slug}/buy`, {
        ...(from.o ? { o: from.o } : {}),
        ...(from.wa ? { wa: from.wa } : {}),
        ...(askCpf ? { document: digits(v.document) } : {}),
        ...(oneTap ? {} : { customer: { name: v.name.trim(), email: v.email.trim(), phone: nationalPhone(v.phone) } }),
        tracking,
      });
    },
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
    if (!oneTap) {
      if (v.name.trim().split(/\s+/).length < 2) err.name = 'Informe seu nome completo';
      if (!/^\S+@\S+\.\S{2,}$/.test(v.email.trim())) err.email = 'E-mail inválido';
      if (digits(v.phone).length < 10) err.phone = 'Informe seu WhatsApp com DDD';
    }
    if (askCpf && !isValidCpf(v.document)) err.document = 'CPF inválido';
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

  const input = 'h-12 w-full rounded-xl border border-zinc-300 bg-white px-3.5 text-[16px] text-zinc-900 outline-none transition focus:border-zinc-900 focus:ring-4 focus:ring-zinc-900/10';
  const cta = 'flex w-full items-center justify-center gap-2 rounded-2xl py-4 text-[17px] font-extrabold text-white transition hover:brightness-110 disabled:opacity-70';
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="Pagamento">
      <div className="animate-fade-in max-h-[92vh] w-full max-w-[460px] overflow-y-auto rounded-t-3xl bg-white p-5 text-left text-zinc-900 shadow-2xl sm:rounded-3xl sm:p-6">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-bold uppercase tracking-wide" style={{ color: accent }}>{o?.status === 'paid' ? 'Tudo certo' : 'Falta pouco'}</p>
            <h2 className="text-lg font-bold leading-snug">{offer.checkout.product.name}</h2>
            <p className="text-sm text-zinc-500">{discounted ? <>1º mês <b className="text-zinc-900">{brl(price)}</b> · depois {brl(normal)}{club ? '/mês' : ''}</> : club ? `${brl(price)}/mês${club.plan ? ` · Plano ${club.plan}` : ''}` : brl(price)}</p>
          </div>
          {o?.status !== 'paid' && (
            <button type="button" onClick={onClose} aria-label="Fechar" className="rounded-full p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"><X className="h-5 w-5" /></button>
          )}
        </div>

        {!o && (
          <form onSubmit={submit} className="space-y-3" noValidate>
            {oneTap ? (
              <div className="flex items-center gap-3 rounded-2xl bg-zinc-50 p-3.5 ring-1 ring-zinc-200">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-base font-bold text-white" style={{ background: accent }}>{(prefill?.name || '?').trim().charAt(0).toUpperCase()}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">Comprando como {prefill?.name.split(' ')[0]}</p>
                  <p className="truncate text-xs text-zinc-500">{prefill?.email}</p>
                </div>
                <button type="button" onClick={() => setEditing(true)} className="shrink-0 text-xs font-semibold text-zinc-500 underline underline-offset-2 hover:text-zinc-900">alterar</button>
              </div>
            ) : (
              <>
                <Field label="Nome completo" error={errors.name}><input className={input} autoComplete="name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></Field>
                <Field label="E-mail" error={errors.email}><input className={input} type="email" inputMode="email" autoComplete="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} /></Field>
                <Field label="WhatsApp" error={errors.phone}><input className={input} inputMode="tel" autoComplete="tel" value={v.phone} onChange={(e) => setV({ ...v, phone: maskPhone(e.target.value) })} placeholder="(11) 99999-9999" /></Field>
              </>
            )}
            {askCpf && (
              <Field label="CPF (para o Pix Automático)" error={errors.document}><input className={input} inputMode="numeric" value={v.document} onChange={(e) => setV({ ...v, document: maskDocument(e.target.value) })} placeholder="000.000.000-00" /></Field>
            )}
            {create.error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{create.error instanceof ApiError ? create.error.message : 'Não foi possível gerar o Pix. Tente de novo.'}</p>}
            <button type="submit" disabled={create.isPending} className={cta} style={{ background: accent }}>
              {create.isPending ? <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <QrCode className="h-5 w-5" />} {create.isPending ? 'Gerando seu Pix…' : `Pagar ${brl(price)} com Pix`}
            </button>
            {club?.auto && <p className="flex items-start gap-1.5 text-xs text-zinc-500"><Repeat className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Ao pagar, o app do banco pede para autorizar o Pix Automático: confirme para renovar sozinho todo mês. Cancele quando quiser.</p>}
          </form>
        )}

        {o && o.status !== 'paid' && (
          <div className="text-center">
            {o.pix_qr_image && <img src={o.pix_qr_image} alt="QR Code Pix" className="mx-auto h-52 w-52 rounded-xl border border-zinc-200 p-2" />}
            <p className="mt-3 text-sm text-zinc-600">Abra o app do seu banco e escaneie o QR Code, ou copie o código:</p>
            <button type="button" onClick={copy} className={`${cta} mt-3`} style={{ background: accent }}>
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
                <a key={i} href={d.url!} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-emerald-500 py-4 text-[16px] font-extrabold text-white hover:bg-emerald-400">
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

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-zinc-700">{label}</span>
      {children}
      {error && <span className="mt-1 block text-xs font-medium text-red-600">{error}</span>}
    </label>
  );
}
