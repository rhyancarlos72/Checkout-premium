import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Boxes, Check, Gift } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, cn, Field, Input, Modal, PageLoader } from '@/components/ui';
import { adminApi, ApiError } from '@/lib/api';
import { brl, centsToInput, parseMoney } from '@/lib/format';
import type { Product } from './ProductsPage';

interface Item {
  product_id: string;
  price: string;
  compare: string;
  title: string;
}

/** Escolhe quais OUTROS produtos são oferecidos como adicionais (order bump) do produto principal. */
export function ProductBumpsModal({ product, products, onClose, onSaved }: { product: Product; products: Product[]; onClose: () => void; onSaved: () => void }) {
  const current = useQuery({
    queryKey: ['product-bumps', product.id],
    queryFn: () => adminApi.get<{ product_id: string; title: string; price_cents: number; compare_at_cents: number | null }[]>(`/products/${product.id}/bumps`),
  });
  const [items, setItems] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = products.filter((p) => p.id !== product.id);

  useEffect(() => {
    if (current.data && !items)
      setItems(
        current.data
          // bumps antigos que entregavam o próprio produto principal são substituídos
          .filter((b) => b.product_id !== product.id)
          .map((b) => ({ product_id: b.product_id, price: centsToInput(b.price_cents), compare: centsToInput(b.compare_at_cents), title: b.title })),
      );
  }, [current.data, items]);

  const list = items ?? [];
  const toggle = (p: Product) =>
    setItems(list.some((i) => i.product_id === p.id) ? list.filter((i) => i.product_id !== p.id) : [...list, { product_id: p.id, price: centsToInput(p.price_cents), compare: '', title: '' }]);
  const patch = (id: string, v: Partial<Item>) => setItems(list.map((i) => (i.product_id === id ? { ...i, ...v } : i)));
  const move = (idx: number, d: -1 | 1) => {
    const n = [...list];
    [n[idx], n[idx + d]] = [n[idx + d], n[idx]];
    setItems(n);
  };

  async function save() {
    setError(null);
    for (const i of list) if (parseMoney(i.price) < 1) return setError('Informe o preço da oferta de cada produto adicional');
    setBusy(true);
    try {
      await adminApi.put(`/products/${product.id}/bumps`, {
        items: list.map((i) => {
          const normal = others.find((o) => o.id === i.product_id)?.price_cents ?? 0;
          const price = parseMoney(i.price);
          return {
          product_id: i.product_id,
          price_cents: price,
          // "De" vazio + oferta mais barata que o normal → mostra o preço normal riscado
          compare_at_cents: i.compare ? parseMoney(i.compare) : normal > price ? normal : null,
          title: i.title.trim() || undefined,
          };
        }),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao salvar');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`Produtos adicionais · ${product.name}`} wide>
      {current.isLoading || !items ? (
        <PageLoader />
      ) : (
        <div className="space-y-5">
          {current.data?.some((b) => b.product_id === product.id) && (
            <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
              Havia um order bump antigo entregando o <b>próprio produto principal</b>. Escolha abaixo o produto adicional certo e salve: o antigo será substituído.
            </p>
          )}
          <p className="rounded-xl bg-blue-50 px-4 py-3 text-sm text-blue-700">
            Escolha outros produtos para oferecer como <b>order bump</b> no checkout de <b>{product.name}</b>. Quem marcar a oferta recebe o acesso do produto adicional junto com o principal.
          </p>

          {others.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-zinc-500">
              <Boxes className="h-6 w-6 text-zinc-400" /> Cadastre outro produto para poder oferecê-lo como adicional.
            </div>
          ) : (
            <>
              {/* Selecionados (na ordem do checkout) */}
              {list.length > 0 && (
                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Oferecidos no checkout ({list.length})</p>
                  {list.map((i, idx) => {
                    const p = others.find((o) => o.id === i.product_id);
                    if (!p) return null;
                    return (
                      <div key={i.product_id} className="rounded-2xl border-2 border-blue-500/60 bg-blue-50/40 p-4">
                        <div className="flex items-center gap-3">
                          {p.image_url ? <img src={p.image_url} alt="" className="h-12 w-12 rounded-lg object-cover" /> : <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-amber-100 text-amber-700"><Gift className="h-5 w-5" /></div>}
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-semibold text-zinc-900">{p.name}</p>
                            <p className="text-xs text-zinc-500">Preço normal: {brl(p.price_cents)}{p.number ? ` · ID #${p.number}` : ''}</p>
                          </div>
                          <button disabled={idx === 0} onClick={() => move(idx, -1)} className="rounded p-1.5 text-zinc-500 hover:bg-white disabled:opacity-30" aria-label="Subir"><ArrowUp className="h-4 w-4" /></button>
                          <button disabled={idx === list.length - 1} onClick={() => move(idx, 1)} className="rounded p-1.5 text-zinc-500 hover:bg-white disabled:opacity-30" aria-label="Descer"><ArrowDown className="h-4 w-4" /></button>
                          <Button size="sm" variant="ghost" onClick={() => toggle(p)}>Remover</Button>
                        </div>
                        <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_140px_140px]">
                          <Field label="Título da oferta"><Input value={i.title} onChange={(e) => patch(i.product_id, { title: e.target.value })} placeholder={`Leve também: ${p.name}`} className="h-11" /></Field>
                          <Field label="Preço da oferta"><Input value={i.price} onChange={(e) => patch(i.product_id, { price: e.target.value })} inputMode="decimal" className="h-11" /></Field>
                          <Field label="Preço “De”"><Input value={i.compare} onChange={(e) => patch(i.product_id, { compare: e.target.value })} inputMode="decimal" placeholder={centsToInput(p.price_cents)} className="h-11" /></Field>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Disponíveis */}
              {others.some((p) => !list.some((i) => i.product_id === p.id)) && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">Seus produtos</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {others
                      .filter((p) => !list.some((i) => i.product_id === p.id))
                      .map((p) => (
                        <button key={p.id} onClick={() => toggle(p)} disabled={list.length >= 10} className="flex items-center gap-3 rounded-xl border border-dashed border-zinc-300 p-3 text-left transition hover:border-blue-500 hover:bg-blue-50/40 disabled:opacity-50">
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 border-zinc-300" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-zinc-900">{p.name}</span>
                            <span className={cn('block text-xs', p.active ? 'text-zinc-500' : 'text-amber-600')}>{brl(p.price_cents)}{!p.active && ' · inativo'}</span>
                          </span>
                        </button>
                      ))}
                  </div>
                </div>
              )}
            </>
          )}

          {error && <p className="rounded-xl bg-red-50 px-3 py-2.5 text-sm font-medium text-red-700">{error}</p>}
          <div className="flex justify-end gap-2 border-t border-zinc-100 pt-4">
            <Button variant="secondary" onClick={onClose}>Cancelar</Button>
            <Button loading={busy} onClick={save}><Check className="h-4 w-4" /> Salvar produtos adicionais</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
