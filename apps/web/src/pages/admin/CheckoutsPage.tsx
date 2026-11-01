import { Copy, CreditCard, ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button, Card, EmptyState, PageLoader, useToast } from '@/components/ui';
import { brl } from '@/lib/format';
import { PageHeader } from './AdminApp';
import { CheckoutEditor, type Checkout } from './CheckoutEditor';
import type { Bump } from './BumpsPage';
import { useCrud } from './crud';
import type { Product } from './ProductsPage';

export default function CheckoutsPage() {
  const { list, save, remove } = useCrud<Checkout>('checkouts');
  const products = useCrud<Product>('products').list;
  const bumps = useCrud<Bump>('bumps').list;
  const [editing, setEditing] = useState<Checkout | 'new' | null>(null);
  const toast = useToast();
  const url = (slug: string) => `${window.location.origin}/c/${slug}`;

  return (
    <>
      <PageHeader title="Checkouts" subtitle="Cada checkout tem link, visual, gateway e ofertas próprias" action={<Button onClick={() => setEditing('new')} disabled={!products.data?.length}><Plus className="h-4 w-4" /> Novo checkout</Button>} />
      {list.isLoading ? (
        <PageLoader />
      ) : !list.data?.length ? (
        <Card><EmptyState icon={<CreditCard className="h-6 w-6" />} title="Nenhum checkout" text={products.data?.length ? 'Crie um checkout para começar a vender.' : 'Cadastre um produto primeiro.'} /></Card>
      ) : (
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {list.data.map((c) => (
            <div key={c.id} className="group overflow-hidden rounded-2xl border border-zinc-200/70 bg-white shadow-[0_1px_2px_rgba(16,24,40,.04),0_8px_24px_-12px_rgba(16,24,40,.08)] transition hover:-translate-y-0.5 hover:shadow-[0_16px_40px_-16px_rgba(16,24,40,.22)]">
              <button type="button" onClick={() => setEditing(c)} className="relative block h-32 w-full overflow-hidden text-left" style={{ background: `linear-gradient(135deg, ${c.theme?.primaryColor || '#059669'}, ${c.theme?.mode === 'dark' ? '#0a0b10' : '#0f172a'})` }}>
                {(c.theme?.bannerUrl || c.theme?.mockupUrl) && <img src={c.theme.bannerUrl || c.theme.mockupUrl || ''} alt="" className="absolute inset-0 h-full w-full object-cover opacity-90 transition duration-500 group-hover:scale-105" />}
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/10 to-transparent" />
                <div className="absolute left-4 top-3 flex gap-1.5">
                  <span className={c.active ? 'rounded-full bg-emerald-500 px-2 py-0.5 text-[11px] font-semibold text-white' : 'rounded-full bg-zinc-500 px-2 py-0.5 text-[11px] font-semibold text-white'}>{c.active ? 'Ativo' : 'Inativo'}</span>
                  <span className="rounded-full bg-white/20 px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur">{c.provider === 'efi' ? 'Efí' : 'Woovi'}</span>
                  {c.theme?.mode === 'dark' && <span className="rounded-full bg-white/20 px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur">Escuro</span>}
                </div>
                <div className="absolute bottom-3 left-4 right-4">
                  <p className="truncate font-semibold text-white">{c.name}</p>
                  <p className="truncate text-xs text-white/75">{c.product?.name} · {brl(c.price_cents ?? c.product?.price_cents ?? 0)}</p>
                </div>
              </button>
              <div className="space-y-3 p-4">
                <div className="flex items-center gap-2 rounded-xl bg-zinc-50 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-600">{url(c.slug)}</span>
                  <button className="rounded p-1 text-zinc-500 hover:bg-white hover:text-zinc-900" aria-label="Copiar link" onClick={() => navigator.clipboard.writeText(url(c.slug)).then(() => toast.ok('Link copiado'))}><Copy className="h-4 w-4" /></button>
                  <a className="rounded p-1 text-zinc-500 hover:bg-white hover:text-zinc-900" href={url(c.slug)} target="_blank" rel="noreferrer" aria-label="Abrir"><ExternalLink className="h-4 w-4" /></a>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="secondary" onClick={() => setEditing(c)}><Pencil className="h-3.5 w-3.5" /> Editar e personalizar</Button>
                  <span className="flex-1" />
                  <Button size="sm" variant="ghost" aria-label="Excluir" onClick={() => confirm(`Excluir checkout "${c.name}"?`) && remove.mutate(c.id, { onError: (e) => toast.err(e.message) })}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && (
        <CheckoutEditor
          checkout={editing === 'new' ? null : editing}
          products={products.data ?? []}
          bumps={bumps.data ?? []}
          onClose={() => setEditing(null)}
          onSave={async (b) => {
            await save.mutateAsync(b);
            toast.ok('Checkout salvo');
            setEditing(null);
          }}
        />
      )}
      {toast.node}
    </>
  );
}

