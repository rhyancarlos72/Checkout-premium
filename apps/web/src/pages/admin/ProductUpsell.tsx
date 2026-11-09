import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Rocket, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { ImageUpload } from '@/components/ImageUpload';
import { Button, cn, Field, Input, Modal, Select, Switch, Textarea } from '@/components/ui';
import { adminApi, ApiError } from '@/lib/api';
import { brl, centsToInput, parseMoney, productCode } from '@/lib/format';
import type { Product } from './ProductsPage';

export interface Upsell {
  id: string;
  product_id: string;
  offer_product_id: string;
  headline: string | null;
  title: string | null;
  description: string | null;
  image_url: string | null;
  price_cents: number;
  compare_at_cents: number | null;
  cta_text: string | null;
  active: boolean;
}

/** Seção do card do produto: oferta exibida em popup quando o Pix é aprovado. */
export function UpsellSection({ product, products, upsell, onEdit }: { product: Product; products: Product[]; upsell?: Upsell; onEdit: () => void }) {
  const offer = upsell ? products.find((p) => p.id === upsell.offer_product_id) : null;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Upsell (após o pagamento)</p>
        <button onClick={onEdit} className="text-xs font-semibold text-blue-600 hover:underline">{upsell ? 'Editar' : 'Adicionar'}</button>
      </div>
      {!upsell ? (
        <button onClick={onEdit} className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-300 py-2.5 text-xs font-medium text-zinc-500 transition hover:border-violet-500 hover:text-violet-600">
          <Plus className="h-3.5 w-3.5" /> Oferecer um produto depois da compra
        </button>
      ) : (
        <div className={cn('flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs', upsell.active ? 'bg-violet-50' : 'bg-zinc-100')}>
          <Rocket className="h-3.5 w-3.5 shrink-0 text-violet-600" />
          <span className="pv min-w-0 flex-1 truncate font-medium text-zinc-800">{upsell.title || offer?.name || 'Oferta'}</span>
          {!upsell.active && <span className="shrink-0 text-[11px] text-zinc-500">pausado</span>}
          <span className="pv shrink-0 font-semibold tabular-nums text-zinc-700">{brl(upsell.price_cents)}</span>
        </div>
      )}
      {upsell && upsell.offer_product_id === product.id && <p className="mt-1 text-[11px] text-red-600">O upsell precisa ser outro produto.</p>}
    </div>
  );
}

export function UpsellModal({ product, products, upsell, onClose, toast }: { product: Product; products: Product[]; upsell?: Upsell; onClose: () => void; toast: { ok: (m: string) => void; err: (m: string) => void } }) {
  const qc = useQueryClient();
  const others = products.filter((p) => p.id !== product.id);
  const [f, setF] = useState({
    offer_product_id: upsell?.offer_product_id ?? '',
    headline: upsell?.headline ?? '',
    title: upsell?.title ?? '',
    description: upsell?.description ?? '',
    image_url: upsell?.image_url ?? '',
    price: upsell ? centsToInput(upsell.price_cents) : '',
    compare: upsell?.compare_at_cents ? centsToInput(upsell.compare_at_cents) : '',
    cta_text: upsell?.cta_text ?? '',
    active: upsell?.active ?? true,
  });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const offer = others.find((p) => p.id === f.offer_product_id);
  const done = (msg: string) => (qc.invalidateQueries({ queryKey: ['upsells'] }), toast.ok(msg), onClose());
  const save = useMutation({
    mutationFn: () =>
      adminApi.put(`/products/${product.id}/upsell`, {
        offer_product_id: f.offer_product_id,
        headline: f.headline || null,
        title: f.title || null,
        description: f.description || null,
        image_url: f.image_url || '',
        price_cents: parseMoney(f.price),
        compare_at_cents: f.compare ? parseMoney(f.compare) : null,
        cta_text: f.cta_text || null,
        active: f.active,
      }),
    onSuccess: () => done('Upsell salvo'),
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro ao salvar'),
  });
  const remove = useMutation({
    mutationFn: () => adminApi.del(`/products/${product.id}/upsell`),
    onSuccess: () => done('Upsell removido'),
    onError: (e) => toast.err(e instanceof ApiError ? e.message : 'Erro ao remover'),
  });

  return (
    <Modal open onClose={onClose} title={`Upsell de “${product.name}”`} wide>
      <div className="space-y-5">
        <p className="rounded-xl bg-violet-50 p-3 text-sm text-violet-800">Assim que o Pix de <b>{product.name}</b> for aprovado, o cliente vê esta oferta em um popup. Se aceitar, recebe um Pix só do adicional, sem preencher nada. Se recusar, segue para a página de acesso.</p>
        <Field label="Produto oferecido">
          <Select
            value={f.offer_product_id}
            onChange={(e) => {
              const p = others.find((o) => o.id === e.target.value);
              set({ offer_product_id: e.target.value, ...(p && !f.price ? { price: centsToInput(Math.round(p.price_cents * 0.6)), compare: centsToInput(p.price_cents) } : {}) });
            }}
          >
            <option value="">Escolha um produto…</option>
            {others.map((p) => (
              <option key={p.id} value={p.id}>{p.number ? `ID: ${productCode(p.number)} · ` : ''}{p.name} ({brl(p.price_cents)})</option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Preço da oferta (R$)"><Input value={f.price} onChange={(e) => set({ price: e.target.value })} inputMode="decimal" placeholder="Ex.: 19,90" /></Field>
          <Field label="Preço “De” riscado (opcional)"><Input value={f.compare} onChange={(e) => set({ compare: e.target.value })} inputMode="decimal" placeholder={offer ? centsToInput(offer.price_cents) : 'Ex.: 47,00'} /></Field>
        </div>
        <Field label="Chamada do topo" hint="Ex.: Espere! Uma oferta exclusiva para você"><Input value={f.headline} onChange={(e) => set({ headline: e.target.value })} placeholder="Espere! Uma oferta exclusiva para você" /></Field>
        <Field label="Título da oferta" hint="Vazio = nome do produto"><Input value={f.title} onChange={(e) => set({ title: e.target.value })} placeholder={offer?.name ?? ''} /></Field>
        <Field label="Descrição"><Textarea rows={3} value={f.description} onChange={(e) => set({ description: e.target.value })} placeholder={offer?.description ?? 'Por que vale a pena levar agora?'} /></Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ImageUpload kind="thumb" label="Imagem (vazio = imagem do produto)" value={f.image_url} onChange={(url) => set({ image_url: url })} />
          <Field label="Texto do botão" hint="Vazio = “Sim, quero por R$ X”"><Input value={f.cta_text} onChange={(e) => set({ cta_text: e.target.value })} placeholder="Sim, quero aproveitar!" /></Field>
        </div>
        <Switch checked={f.active} onChange={(v) => set({ active: v })} label="Oferta ativa" />
        <div className="flex flex-wrap items-center gap-2">
          {upsell && <Button variant="ghost" loading={remove.isPending} onClick={() => confirm('Remover o upsell deste produto?') && remove.mutate()}><Trash2 className="h-4 w-4" /> Remover</Button>}
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button loading={save.isPending} disabled={!f.offer_product_id || parseMoney(f.price) < 100} onClick={() => save.mutate()}>Salvar upsell</Button>
        </div>
      </div>
    </Modal>
  );
}
