import { ImageUpload } from '@/components/ImageUpload';
import { zodResolver } from '@hookform/resolvers/zod';
import { Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, PageLoader, Select, Switch, Textarea, useToast } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { brl, centsToInput, parseMoney } from '@/lib/format';
import { PageHeader } from './AdminApp';
import { useCrud } from './crud';
import type { Product } from './ProductsPage';

export interface Bump {
  id: string;
  product_id: string;
  title: string;
  description: string | null;
  price_cents: number;
  compare_at_cents: number | null;
  image_url: string | null;
  active: boolean;
  product?: { name: string };
}

const schema = z.object({
  product_id: z.string().uuid('Escolha o produto entregue'),
  title: z.string().trim().min(2, 'Obrigatório'),
  description: z.string().optional(),
  price: z.string().refine((v) => parseMoney(v) >= 1, 'Informe o preço'),
  compare: z.string().optional(),
  image_url: z.string().optional(),
  active: z.boolean(),
});

export default function BumpsPage() {
  const { list, save, remove } = useCrud<Bump>('bumps');
  const products = useCrud<Product>('products').list;
  const [editing, setEditing] = useState<Bump | 'new' | null>(null);
  const toast = useToast();

  return (
    <>
      <PageHeader title="Order bumps" subtitle="Ofertas adicionais exibidas no checkout com um clique" action={<Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Novo order bump</Button>} />
      {list.isLoading ? (
        <PageLoader />
      ) : !list.data?.length ? (
        <Card><EmptyState icon={<Sparkles className="h-6 w-6" />} title="Nenhum order bump" text="Order bumps aumentam o ticket médio. Crie um e vincule a um checkout." /></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="-m-5 divide-y divide-gray-100">
            {list.data.map((b) => (
              <div key={b.id} className="flex items-center gap-4 px-5 py-4">
                {b.image_url ? <img src={b.image_url} alt="" className="h-12 w-12 rounded-lg object-cover" /> : <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-gray-100"><Sparkles className="h-5 w-5 text-gray-400" /></div>}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{b.title}</p>
                  <p className="truncate text-xs text-gray-500">Entrega: {b.product?.name ?? '—'}</p>
                </div>
                <div className="text-right">
                  {b.compare_at_cents ? <p className="text-xs text-gray-400 line-through">{brl(b.compare_at_cents)}</p> : null}
                  <p className="font-semibold tabular-nums">{brl(b.price_cents)}</p>
                </div>
                <Badge tone={b.active ? 'on' : 'off'}>{b.active ? 'Ativo' : 'Inativo'}</Badge>
                <div className="flex">
                  <Button size="sm" variant="ghost" aria-label="Editar" onClick={() => setEditing(b)}><Pencil className="h-4 w-4" /></Button>
                  <Button size="sm" variant="ghost" aria-label="Excluir" onClick={() => confirm('Excluir order bump?') && remove.mutate(b.id, { onError: (e) => toast.err(e.message) })}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
      {editing && <BumpForm bump={editing === 'new' ? null : editing} products={products.data ?? []} onClose={() => setEditing(null)} onSave={async (b) => { await save.mutateAsync(b); toast.ok('Order bump salvo'); setEditing(null); }} />}
      {toast.node}
    </>
  );
}

function BumpForm({ bump, products, onClose, onSave }: { bump: Bump | null; products: Product[]; onClose: () => void; onSave: (b: any) => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, control, formState } = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      product_id: bump?.product_id ?? '',
      title: bump?.title ?? '',
      description: bump?.description ?? '',
      price: centsToInput(bump?.price_cents),
      compare: centsToInput(bump?.compare_at_cents),
      image_url: bump?.image_url ?? '',
      active: bump?.active ?? true,
    },
  });
  const e = formState.errors;
  return (
    <Modal open onClose={onClose} title={bump ? 'Editar order bump' : 'Novo order bump'}>
      <form
        className="space-y-4"
        onSubmit={handleSubmit(async ({ price, compare, ...v }) => {
          setError(null);
          try {
            await onSave({ ...v, id: bump?.id, price_cents: parseMoney(price), compare_at_cents: compare ? parseMoney(compare) || null : null, description: v.description || null });
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Erro ao salvar');
          }
        })}
      >
        <Field label="Produto entregue" error={e.product_id?.message} hint="O comprador recebe o acesso deste produto">
          <Select {...register('product_id')}>
            <option value="">Selecione…</option>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="Título da oferta" error={e.title?.message}><Input {...register('title')} placeholder="Sim, quero adicionar o Pack Bônus!" /></Field>
        <Field label="Descrição persuasiva"><Textarea {...register('description')} rows={3} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Preço da oferta (R$)" error={e.price?.message}><Input {...register('price')} inputMode="decimal" placeholder="19,90" /></Field>
          <Field label="Preço “de” (opcional)"><Input {...register('compare')} inputMode="decimal" placeholder="47,00" /></Field>
        </div>
        <Controller control={control} name="image_url" render={({ field }) => <ImageUpload label="Imagem" value={field.value} onChange={field.onChange} />} />
        <Controller control={control} name="active" render={({ field }) => <Switch checked={field.value} onChange={field.onChange} label="Ativo" />} />
        {error && <p className="text-sm font-medium text-red-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={formState.isSubmitting}>Salvar</Button>
        </div>
      </form>
    </Modal>
  );
}
