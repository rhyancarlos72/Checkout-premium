import { useQuery } from '@tanstack/react-query';
import { ShoppingBag } from 'lucide-react';
import { useParams, useSearchParams } from 'react-router-dom';
import { publicApi } from '@/lib/api';
import { CheckoutView } from './CheckoutView';
import type { PublicCheckout } from './theme';

export { PixIcon } from './CheckoutView';
export { themeStyle } from './theme';
export type { PublicCheckout, Theme } from './theme';

function Skeleton() {
  return (
    <div className="min-h-screen bg-[#f4f5f7]">
      <div className="h-16 border-b border-zinc-200 bg-white" />
      <div className="mx-auto grid max-w-[1120px] gap-6 px-4 py-8 lg:grid-cols-[1fr_380px]">
        <div className="space-y-5">
          {[140, 300, 140].map((h, i) => <div key={i} className="animate-pulse rounded-2xl bg-white" style={{ height: h }} />)}
        </div>
        <div className="hidden space-y-5 lg:block">
          <div className="h-72 animate-pulse rounded-2xl bg-white" />
          <div className="h-56 animate-pulse rounded-2xl bg-white" />
        </div>
      </div>
    </div>
  );
}

/** Checkout já embutido no HTML pelo servidor (abre sem esperar a API → banner/LCP muito mais rápido). */
function embedded(slug: string): PublicCheckout | undefined {
  try {
    const el = document.getElementById('ck-data');
    if (!el?.textContent) return undefined;
    const v = JSON.parse(el.textContent) as { slug: string; data: PublicCheckout };
    return v.slug === slug ? v.data : undefined;
  } catch {
    return undefined;
  }
}

export default function CheckoutPage() {
  const params = useParams();
  const [search] = useSearchParams();
  // /checkout?produto_id=9452229 (padrão) ou /c/:slug (links antigos)
  const slug = search.get('produto_id') ?? params.slug ?? '';
  const { data, isLoading, error } = useQuery({
    queryKey: ['checkout', slug],
    queryFn: () => publicApi.get<PublicCheckout>(`/checkouts/${slug}`),
    initialData: () => embedded(slug),
    // abre na hora com os dados do HTML e confirma em segundo plano: preço/bumps sempre atualizados,
    // mesmo se a hospedagem ou o navegador servirem uma cópia antiga da página
    initialDataUpdatedAt: 0,
    retry: 1,
  });

  if (isLoading) return <Skeleton />;
  if (error || !data)
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f4f5f7] p-6 text-center">
        <div className="max-w-sm">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-white shadow-sm"><ShoppingBag className="h-6 w-6 text-zinc-400" /></div>
          <p className="text-lg font-semibold">Checkout indisponível</p>
          <p className="mt-1 text-sm text-zinc-500">Este link não existe ou foi desativado pelo vendedor.</p>
        </div>
      </div>
    );
  return (
    <div className="min-h-screen">
      <CheckoutView checkout={data} />
    </div>
  );
}
