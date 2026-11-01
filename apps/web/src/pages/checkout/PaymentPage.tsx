import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, Copy, CopyCheck, ExternalLink, Loader2, Lock, RefreshCw, Smartphone } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, PageLoader } from '@/components/ui';
import { publicApi } from '@/lib/api';
import { brl } from '@/lib/format';
import { initMetaPixel, pixel, track } from '@/lib/tracking';
import { PixIcon, themeStyle, type Theme } from './CheckoutPage';

interface PublicOrder {
  number: number;
  status: 'pending' | 'paid' | 'expired' | 'canceled' | 'refunded' | 'failed';
  total_cents: number;
  subtotal_cents: number;
  discount_cents: number;
  pix_code: string | null;
  pix_qr_image: string | null;
  expires_at: string | null;
  items: { kind: string; name: string; price_cents: number }[];
  customer: { name: string; email: string } | null;
  checkout: { slug: string; name: string; theme: Theme; metaPixelId: string | null } | null;
  purchase_event_id: string | null;
  delivery: { name: string; url: string | null; note: string | null }[];
}

function useCountdown(iso: string | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!iso) return null;
  const left = Math.max(0, Math.floor((new Date(iso).getTime() - now) / 1000));
  return { left, label: `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}` };
}

export default function PaymentPage() {
  const { token = '' } = useParams();
  const qc = useQueryClient();
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
  const [copied, setCopied] = useState(false);
  const firedRef = useRef(false);
  const countdown = useCountdown(order?.expires_at ?? null);

  useEffect(() => {
    if (!order?.checkout) return;
    initMetaPixel(order.checkout.metaPixelId);
    if (order.status === 'pending') track(order.checkout.slug, 'payment_page_view');
  }, [order?.checkout?.slug]); // eslint-disable-line react-hooks/exhaustive-deps

  // Purchase no Pixel (mesmo event_id enviado ao PayTracking → a Meta deduplica)
  useEffect(() => {
    if (order?.status !== 'paid' || firedRef.current) return;
    firedRef.current = true;
    const key = `ck_purchase_${token}`;
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, '1');
    } catch {
      /* ignore */
    }
    pixel('Purchase', { value: order.total_cents / 100, currency: 'BRL' }, order.purchase_event_id ?? undefined);
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

  if (isLoading) return <PageLoader />;
  if (error || !order)
    return <div className="flex min-h-screen items-center justify-center p-6 text-center text-gray-600">Pedido não encontrado.</div>;

  const theme = order.checkout?.theme ?? {};
  const expired = order.status === 'expired' || (order.status === 'pending' && countdown?.left === 0);

  return (
    <div style={themeStyle(theme)} className="min-h-screen">
      <header className="border-b border-black/5 bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-xl items-center justify-between px-4">
          {theme.logoUrl ? <img src={theme.logoUrl} alt="" className="h-8 w-auto max-w-[160px] object-contain" /> : <span className="font-semibold">Pedido #{order.number}</span>}
          <span className="flex items-center gap-1.5 text-xs font-medium text-gray-600">
            <Lock className="h-3.5 w-3.5 text-emerald-600" /> Ambiente seguro
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-xl px-4 py-6 sm:py-10">
        {order.status === 'paid' ? (
          <section className="animate-fade-in rounded-2xl border border-gray-200 bg-white p-6 text-center shadow-sm sm:p-8">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-50">
              <CheckCircle2 className="h-9 w-9 text-emerald-600" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">Pagamento aprovado!</h1>
            <p className="mt-2 text-gray-600">
              Obrigado{order.customer ? `, ${order.customer.name.split(' ')[0]}` : ''}! Enviamos o acesso para <b>{order.customer?.email}</b>.
            </p>
            <div className="mt-6 space-y-3 text-left">
              {order.delivery.map((d, i) => (
                <div key={i} className="rounded-xl border border-gray-200 p-4">
                  <p className="font-semibold">{d.name}</p>
                  {d.note && <p className="mt-1 text-sm text-gray-600">{d.note}</p>}
                  {d.url ? (
                    <a href={d.url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex h-11 items-center gap-2 rounded-xl bg-brand px-4 text-sm font-semibold text-brand-fg">
                      Acessar agora <ExternalLink className="h-4 w-4" />
                    </a>
                  ) : (
                    <p className="mt-2 text-sm text-gray-500">O acesso será enviado por e-mail.</p>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-6 text-xs text-gray-500">Não recebeu? Verifique a caixa de spam ou promoções.</p>
          </section>
        ) : expired ? (
          <section className="rounded-2xl border border-gray-200 bg-white p-6 text-center shadow-sm sm:p-8">
            <Clock className="mx-auto mb-3 h-10 w-10 text-gray-400" />
            <h1 className="text-xl font-bold">Este PIX expirou</h1>
            <p className="mt-2 text-gray-600">Sem problemas — gere um novo código em segundos.</p>
            {order.checkout && (
              <Link to={`/c/${order.checkout.slug}?recover=${token}`} className="mt-5 inline-flex h-12 items-center rounded-xl bg-brand px-6 font-semibold text-brand-fg">
                Gerar novo PIX
              </Link>
            )}
          </section>
        ) : order.status === 'pending' ? (
          <section className="animate-fade-in rounded-2xl border border-gray-200 bg-white shadow-sm">
            <div className="border-b border-gray-100 p-5 text-center sm:p-6">
              <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-700">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Aguardando pagamento
              </div>
              <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Pague {brl(order.total_cents)} com PIX</h1>
              {countdown && (
                <p className="mt-1 text-sm text-gray-600">
                  O código expira em <span className="font-semibold tabular-nums text-gray-900">{countdown.label}</span>
                </p>
              )}
            </div>

            <div className="space-y-5 p-5 sm:p-6">
              <div>
                <p className="mb-2 text-sm font-medium text-gray-700">PIX Copia e Cola</p>
                <div className="break-all rounded-xl border border-gray-200 bg-gray-50 p-3 font-mono text-xs leading-relaxed text-gray-700">{order.pix_code}</div>
                <Button variant="brand" size="lg" className="mt-3 w-full" onClick={copy}>
                  {copied ? (
                    <>
                      <CopyCheck className="h-5 w-5" /> Código copiado!
                    </>
                  ) : (
                    <>
                      <Copy className="h-5 w-5" /> Copiar código PIX
                    </>
                  )}
                </Button>
              </div>

              {order.pix_qr_image && (
                <div className="flex flex-col items-center">
                  <p className="mb-2 text-sm font-medium text-gray-700">ou escaneie o QR Code</p>
                  <img src={order.pix_qr_image} alt="QR Code PIX" className="h-56 w-56 rounded-xl border border-gray-200 p-2" />
                </div>
              )}

              <ol className="space-y-3 rounded-xl bg-gray-50 p-4 text-sm text-gray-700">
                {[
                  ['Abra o app do seu banco', Smartphone],
                  ['Escolha pagar com PIX “Copia e Cola” ou QR Code', PixIcon],
                  ['Cole o código e confirme. A liberação é automática.', CheckCircle2],
                ].map(([text, Icon]: any, i) => (
                  <li key={i} className="flex items-center gap-3">
                    <Icon className="h-5 w-5 shrink-0 text-brand" />
                    {text}
                  </li>
                ))}
              </ol>

              <Button variant="secondary" className="w-full" loading={refresh.isPending} onClick={() => refresh.mutate()}>
                <RefreshCw className="h-4 w-4" /> Já paguei
              </Button>
            </div>
          </section>
        ) : (
          <section className="rounded-2xl border border-gray-200 bg-white p-6 text-center shadow-sm">
            <h1 className="text-xl font-bold">Pedido indisponível</h1>
            <p className="mt-2 text-gray-600">Não foi possível concluir este pedido. Tente novamente.</p>
            {order.checkout && (
              <Link to={`/c/${order.checkout.slug}`} className="mt-5 inline-flex h-12 items-center rounded-xl bg-brand px-6 font-semibold text-brand-fg">
                Voltar ao checkout
              </Link>
            )}
          </section>
        )}

        <section className="mt-5 rounded-2xl border border-gray-200 bg-white p-5 text-sm shadow-sm">
          <p className="mb-3 font-semibold">Pedido #{order.number}</p>
          <div className="space-y-1.5">
            {order.items.map((it, i) => (
              <div key={i} className="flex justify-between gap-3 text-gray-700">
                <span>{it.name}</span>
                <span className="tabular-nums">{brl(it.price_cents)}</span>
              </div>
            ))}
            {order.discount_cents > 0 && (
              <div className="flex justify-between text-emerald-700">
                <span>Desconto</span>
                <span className="tabular-nums">−{brl(order.discount_cents)}</span>
              </div>
            )}
            <div className="flex justify-between border-t border-gray-100 pt-2 font-semibold">
              <span>Total</span>
              <span className="tabular-nums">{brl(order.total_cents)}</span>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
