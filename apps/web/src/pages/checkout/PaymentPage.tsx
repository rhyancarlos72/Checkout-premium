import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CheckCircle2, Clock, Copy, CopyCheck, ExternalLink, Lock, Mail, QrCode, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { cn } from '@/components/ui';
import { checkoutPath } from '@/lib/links';
import { publicApi } from '@/lib/api';
import { brl, productCode } from '@/lib/format';
import { initMetaPixel, pixel, track } from '@/lib/tracking';
import { PixIcon, PixLogo } from './CheckoutView';
import { themeDefaults, themeStyle, usePrefersDark, type Theme } from './theme';

interface PublicOrder {
  number: number;
  status: 'pending' | 'paid' | 'expired' | 'canceled' | 'refunded' | 'failed';
  total_cents: number;
  subtotal_cents: number;
  discount_cents: number;
  pix_code: string | null;
  pix_qr_image: string | null;
  expires_at: string | null;
  created_at: string;
  items: { kind: string; name: string; price_cents: number }[];
  customer: { name: string; email: string; phone?: string | null } | null;
  content_ids?: string[];
  external_id?: string | null;
  checkout: { slug: string; name: string; theme: Theme; metaPixelId: string | null } | null;
  purchase_event_id: string | null;
  delivery: { name: string; url: string | null; note: string | null }[];
}

function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function Steps({ current }: { current: 1 | 2 | 3 }) {
  const steps = ['Dados', 'Pagamento', 'Acesso'];
  return (
    <ol className="mx-auto mb-6 flex max-w-sm items-center">
      {steps.map((s, i) => {
        const n = (i + 1) as 1 | 2 | 3;
        const done = n < current || current === 3;
        const active = n === current && current !== 3;
        return (
          <li key={s} className={cn('flex items-center', i < steps.length - 1 && 'flex-1')}>
            <div className="flex flex-col items-center gap-1.5">
              <span className={cn('flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold transition', done ? 'bg-brand text-brand-fg' : active ? 'animate-pulse-ring border-2 border-brand bg-ck-surface text-brand' : 'border-2 border-ck-border bg-ck-surface text-ck-muted')}>
                {done ? <Check className="h-4 w-4" strokeWidth={3} /> : n}
              </span>
              <span className={cn('text-[11px] font-semibold', done || active ? 'text-ck-text' : 'text-ck-muted')}>{s}</span>
            </div>
            {i < steps.length - 1 && <span className={cn('mx-2 mb-5 h-0.5 flex-1 rounded-full', n < current || current === 3 ? 'bg-brand' : 'bg-ck-border')} />}
          </li>
        );
      })}
    </ol>
  );
}

function Confetti() {
  const pieces = useMemo(
    () =>
      Array.from({ length: 42 }, (_, i) => ({
        left: Math.random() * 100,
        delay: Math.random() * 0.8,
        dur: 2.4 + Math.random() * 1.8,
        color: ['var(--brand)', '#fbbf24', '#34d399', '#60a5fa', '#f472b6'][i % 5],
        size: 6 + Math.random() * 6,
      })),
    [],
  );
  return (
    <div className="pointer-events-none fixed inset-0 z-50 overflow-hidden motion-reduce:hidden" aria-hidden>
      {pieces.map((p, i) => (
        <span key={i} className="absolute top-0 rounded-sm" style={{ left: `${p.left}%`, width: p.size, height: p.size * 0.5, background: p.color, animation: `ck-confetti ${p.dur}s ${p.delay}s ease-in forwards` }} />
      ))}
    </div>
  );
}

function Shell({ theme, children }: { theme: Theme; children: ReactNode }) {
  const t = { ...themeDefaults, ...theme };
  const prefersDark = usePrefersDark();
  return (
    <div style={themeStyle(t, prefersDark)} className="min-h-screen bg-ck-bg font-checkout text-ck-text antialiased">
      <header className="border-b border-ck-border bg-ck-surface/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-2xl items-center justify-between px-4">
          {t.logoUrl ? <img src={t.logoUrl} alt="" className="h-8 w-auto max-w-[150px] object-contain" /> : <PixLogo className="text-base" />}
          <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-600"><Lock className="h-3.5 w-3.5" /> Ambiente seguro</span>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-6 sm:py-10">{children}</main>
    </div>
  );
}

export default function PaymentPage() {
  const { token = '' } = useParams();
  const qc = useQueryClient();
  const now = useNow();
  const { data: order, isLoading, error } = useQuery({
    queryKey: ['order', token],
    queryFn: () => publicApi.get<PublicOrder>(`/orders/${token}`),
    refetchInterval: (q) => (q.state.data?.status === 'pending' ? 4000 : false),
    refetchIntervalInBackground: true,
  });
  const refresh = useMutation({
    mutationFn: () => publicApi.post<PublicOrder>(`/orders/${token}/refresh`),
    onSuccess: (d) => qc.setQueryData(['order', token], d),
  });
  // Pix vencido (ou link antigo): gera/abre o Pix desta compra com um toque, sem preencher dados
  const navigate = useNavigate();
  const renew = useMutation({
    mutationFn: () => publicApi.post<{ token: string; renewed: boolean; order: PublicOrder }>(`/orders/${token}/renew`),
    onSuccess: (r) => {
      qc.setQueryData(['order', r.token], r.order);
      if (r.token !== token) navigate(`/pedido/${r.token}`, { replace: true });
    },
  });
  const [copied, setCopied] = useState(false);
  const firedRef = useRef(false);

  useEffect(() => {
    if (!order?.checkout) return;
    initMetaPixel(order.checkout.metaPixelId, { email: order.customer?.email, phone: order.customer?.phone, name: order.customer?.name, externalId: order.external_id });
    if (order.status === 'pending') track(order.checkout.slug, 'payment_page_view');
  }, [order?.checkout?.slug]); // eslint-disable-line react-hooks/exhaustive-deps

  // Purchase no Pixel (mesmo event_id enviado ao PayTracking → a Meta deduplica)
  useEffect(() => {
    if (order?.status !== 'paid' || firedRef.current) return;
    firedRef.current = true;
    try {
      const key = `ck_purchase_${token}`;
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, '1');
    } catch {
      /* ignore */
    }
    pixel('Purchase', { value: order.total_cents / 100, currency: 'BRL', content_type: 'product', content_ids: order.content_ids ?? [], num_items: order.items.length, contents: order.items.map((i, idx) => ({ id: order.content_ids?.[idx] ?? i.name, quantity: 1, item_price: i.price_cents / 100 })) }, order.purchase_event_id ?? undefined);
  }, [order?.status, order?.total_cents, order?.purchase_event_id, token]);

  async function copy() {
    if (!order?.pix_code) return;
    try {
      await navigator.clipboard.writeText(order.pix_code);
    } catch {
      const ta = Object.assign(document.createElement('textarea'), { value: order.pix_code });
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
    if (order.checkout) track(order.checkout.slug, 'pix_copied');
  }

  if (isLoading)
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f4f5f7]">
        <span className="h-8 w-8 animate-spin rounded-full border-[3px] border-zinc-300 border-t-zinc-800" />
      </div>
    );
  if (error || !order) return <div className="flex min-h-screen items-center justify-center p-6 text-center text-zinc-600">Pedido não encontrado.</div>;

  const theme = order.checkout?.theme ?? {};
  const expiresAt = order.expires_at ? new Date(order.expires_at).getTime() : null;
  const createdAt = new Date(order.created_at).getTime();
  const left = expiresAt ? Math.max(0, Math.floor((expiresAt - now) / 1000)) : null;
  const totalWindow = expiresAt ? Math.max(1, (expiresAt - createdAt) / 1000) : 1;
  const expired = order.status === 'expired' || (order.status === 'pending' && left === 0);
  const firstName = order.customer?.name.split(' ')[0];

  const summary = (
    <section className="ck-card mt-5 p-5 text-sm">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-semibold">Pedido ID: {productCode(order.number)}</p>
        <p className="text-xs text-ck-muted">{new Date(order.created_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</p>
      </div>
      <div className="space-y-2">
        {order.items.map((it, i) => (
          <div key={i} className="flex justify-between gap-3">
            <span className="text-ck-muted">{it.name}</span>
            <span className="shrink-0 tabular-nums">{brl(it.price_cents)}</span>
          </div>
        ))}
        {order.discount_cents > 0 && (
          <div className="flex justify-between font-medium text-emerald-600"><span>Desconto</span><span className="tabular-nums">−{brl(order.discount_cents)}</span></div>
        )}
        <div className="flex justify-between border-t border-ck-border pt-2.5 text-base font-bold"><span>Total</span><span className="tabular-nums">{brl(order.total_cents)}</span></div>
      </div>
    </section>
  );

  if (order.status === 'paid')
    return (
      <Shell theme={theme}>
        <Confetti />
        <Steps current={3} />
        <section className="ck-card overflow-hidden text-center">
          <div className="relative bg-gradient-to-b from-emerald-500/10 to-transparent px-6 pb-6 pt-10">
            <div className="animate-pop mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500 shadow-xl shadow-emerald-500/30">
              <Check className="h-10 w-10 text-white" strokeWidth={3} />
            </div>
            <h1 className="mt-5 text-[26px] font-bold tracking-tight">Pagamento aprovado!</h1>
            <p className="mx-auto mt-2 max-w-md text-ck-muted">
              Obrigado{firstName ? `, ${firstName}` : ''}! Enviamos os dados de acesso para <b className="text-ck-text">{order.customer?.email}</b>.
            </p>
          </div>
          <div className="space-y-3 px-5 pb-6 text-left sm:px-8">
            {order.delivery.map((d, i) => (
              <div key={i} className="flex flex-col gap-3 rounded-[calc(var(--ck-r)*.8)] border border-ck-border bg-ck-surface-2 p-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{d.name}</p>
                  {d.note && <p className="mt-1 text-sm text-ck-muted">{d.note}</p>}
                  {!d.url && <p className="mt-1 text-sm text-ck-muted">O acesso será enviado por e-mail.</p>}
                </div>
                {d.url && (
                  <a href={d.url} target="_blank" rel="noopener noreferrer" className="ck-cta inline-flex h-11 shrink-0 items-center justify-center gap-2 px-5 text-sm font-bold">
                    Acessar agora <ExternalLink className="h-4 w-4" />
                  </a>
                )}
              </div>
            ))}
            <p className="flex items-center justify-center gap-1.5 pt-2 text-xs text-ck-muted"><Mail className="h-3.5 w-3.5" /> Não recebeu? Confira o spam ou a aba promoções.</p>
          </div>
        </section>
        {summary}
      </Shell>
    );

  if (expired)
    return (
      <Shell theme={theme}>
        <section className="ck-card p-8 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-amber-500/10 text-amber-500"><Clock className="h-8 w-8" /></div>
          <h1 className="mt-4 text-xl font-bold">Este Pix expirou</h1>
          <p className="mt-2 text-ck-muted">Sem problemas: seu pedido continua salvo, com o mesmo valor. Gere um novo código em um toque, sem preencher nada.</p>
          <button type="button" disabled={renew.isPending} onClick={() => renew.mutate()} className="ck-cta mt-6 inline-flex h-12 items-center justify-center gap-2 px-8 font-bold disabled:opacity-70">
            {renew.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />} {renew.isPending ? 'Gerando seu Pix…' : 'Gerar novo Pix'}
          </button>
          {renew.isError && <p className="mt-3 text-sm text-red-500">{renew.error instanceof Error ? renew.error.message : 'Não foi possível gerar agora. Tente de novo.'}</p>}
        </section>
        {summary}
      </Shell>
    );

  if (order.status !== 'pending')
    return (
      <Shell theme={theme}>
        <section className="ck-card p-8 text-center">
          <h1 className="text-xl font-bold">{order.status === 'canceled' ? 'Seu Pix foi atualizado' : 'Pedido indisponível'}</h1>
          <p className="mt-2 text-ck-muted">{order.status === 'canceled' ? 'Este código foi substituído por um mais novo. Toque abaixo para abrir o Pix atual.' : 'Não foi possível concluir este pedido.'}</p>
          {order.status === 'canceled' && (
            <button type="button" disabled={renew.isPending} onClick={() => renew.mutate()} className="ck-cta mt-6 inline-flex h-12 items-center justify-center gap-2 px-8 font-bold disabled:opacity-70">
              {renew.isPending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />} Abrir meu Pix
            </button>
          )}
          {order.checkout && order.status !== 'canceled' && <Link to={checkoutPath(order.checkout.slug)} className="ck-cta mt-6 inline-flex h-12 items-center justify-center px-8 font-bold">Voltar ao checkout</Link>}
        </section>
      </Shell>
    );

  const mm = left !== null ? String(Math.floor(left / 60)).padStart(2, '0') : '--';
  const ss = left !== null ? String(left % 60).padStart(2, '0') : '--';
  const pctLeft = left !== null ? Math.min(100, (left / totalWindow) * 100) : 100;

  return (
    <Shell theme={theme}>
      <Steps current={2} />
      <section className="ck-card overflow-hidden">
        <div className="border-b border-ck-border p-5 text-center sm:p-7">
          <span className="inline-flex items-center gap-2 rounded-full bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-600">
            <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500 opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" /></span>
            Aguardando pagamento
          </span>
          <p className="mt-3 text-sm text-ck-muted">Valor a pagar</p>
          <p className="text-[34px] font-bold leading-tight tracking-tight tabular-nums">{brl(order.total_cents)}</p>
          {left !== null && (
            <div className="mx-auto mt-4 max-w-xs">
              <div className="flex items-center justify-between text-xs text-ck-muted">
                <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> Expira em</span>
                <span className={cn('font-mono text-sm font-bold tabular-nums', left < 120 ? 'text-red-500' : 'text-ck-text')}>{mm}:{ss}</span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-ck-surface-2">
                <div className={cn('h-full rounded-full transition-[width] duration-1000 ease-linear', left < 120 ? 'bg-red-500' : 'bg-brand')} style={{ width: `${pctLeft}%` }} />
              </div>
            </div>
          )}
        </div>

        <div className="grid gap-6 p-5 sm:p-7 md:grid-cols-[1fr_auto] md:items-start">
          <div className="space-y-4">
            <div>
              <p className="mb-2 flex items-center gap-2 text-sm font-semibold"><PixIcon className="h-4 w-4" /> Pix Copia e Cola</p>
              <div className="max-h-24 overflow-y-auto break-all rounded-[calc(var(--ck-r)*.7)] border border-dashed border-ck-border bg-ck-surface-2 p-3 font-mono text-[12px] leading-relaxed text-ck-muted">{order.pix_code}</div>
            </div>
            <button onClick={copy} className={cn('ck-cta flex h-14 w-full items-center justify-center gap-2.5 text-base font-bold', copied && 'bg-emerald-600! text-white!')}>
              {copied ? <><CopyCheck className="h-5 w-5" /> Código copiado!</> : <><Copy className="h-5 w-5" /> Copiar código Pix</>}
            </button>
            <ol className="space-y-3 pt-1 text-sm">
              {[
                [Smartphone, 'Abra o app do seu banco e entre na área Pix'],
                [Copy, 'Escolha “Pix Copia e Cola” e cole o código'],
                [CheckCircle2, 'Confirme o pagamento. A liberação é automática'],
              ].map(([Icon, text]: any, i) => (
                <li key={i} className="flex items-center gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand"><Icon className="h-4 w-4" /></span>
                  <span className="text-ck-muted">{text}</span>
                </li>
              ))}
            </ol>
          </div>

          {order.pix_qr_image && (
            <div className="flex flex-col items-center md:border-l md:border-ck-border md:pl-6">
              <p className="mb-3 flex items-center gap-2 text-sm font-semibold"><QrCode className="h-4 w-4 text-brand" /> Ou escaneie</p>
              <div className="relative rounded-2xl bg-white p-3 shadow-sm ring-1 ring-black/5">
                {(['left-0 top-0 border-l-[3px] border-t-[3px] rounded-tl-xl', 'right-0 top-0 border-r-[3px] border-t-[3px] rounded-tr-xl', 'left-0 bottom-0 border-l-[3px] border-b-[3px] rounded-bl-xl', 'right-0 bottom-0 border-r-[3px] border-b-[3px] rounded-br-xl'] as const).map((c) => (
                  <span key={c} className={cn('absolute h-6 w-6 border-brand', c)} />
                ))}
                <img src={order.pix_qr_image} alt="QR Code Pix" className="h-48 w-48 sm:h-52 sm:w-52" />
              </div>
              <p className="mt-2 text-center text-xs text-ck-muted">Use a câmera do app do banco</p>
            </div>
          )}
        </div>

        <div className="flex flex-col items-center gap-3 border-t border-ck-border bg-ck-surface-2 px-5 py-4 sm:flex-row sm:justify-between sm:px-7">
          <p className="flex items-center gap-2 text-xs text-ck-muted"><ShieldCheck className="h-4 w-4 text-emerald-500" /> A confirmação aparece aqui automaticamente.</p>
          <button onClick={() => refresh.mutate()} disabled={refresh.isPending} className="flex items-center gap-2 rounded-full border border-ck-border bg-ck-surface px-4 py-2 text-sm font-semibold transition hover:border-brand hover:text-brand disabled:opacity-60">
            <RefreshCw className={cn('h-4 w-4', refresh.isPending && 'animate-spin')} /> Já paguei
          </button>
        </div>
      </section>
      {summary}
    </Shell>
  );
}
