import { ImageUpload } from '@/components/ImageUpload';
import { zodResolver } from '@hookform/resolvers/zod';
import { Boxes, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, PageLoader, Select, Switch, Textarea, useToast } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { brl, centsToInput, parseMoney } from '@/lib/format';
import { PageHeader } from './AdminApp';
import { useCrud } from './crud';

export interface Product {
  id: string;
  name: string;
  description: string | null;
  price_cents: number;
  image_url: string | null;
  delivery_type: 'link' | 'file' | 'none';
  delivery_url: string | null;
  delivery_note: string | null;
  active: boolean;
}

const schema = z.object({
  name: z.string().trim().min(2, 'Obrigatório'),
  description: z.string().optional(),
  price: z.string().refine((v) => parseMoney(v) >= 1, 'Informe o preço'),
  image_url: z.string().optional(),
  delivery_type: z.enum(['link', 'file', 'none']),
  delivery_url: z.string().optional(),
  delivery_note: z.string().optional(),
  active: z.boolean(),
});
type Form = z.infer<typeof schema>;

export default function ProductsPage() {
  const { list, save, remove } = useCrud<Product>('products');
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const toast = useToast();

  return (
    <>
      <PageHeader title="Produtos" subtitle="Produtos digitais e como são entregues" action={<Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Novo produto</Button>} />
      {list.isLoading ? (
        <PageLoader />
      ) : !list.data?.length ? (
        <Card>
          <EmptyState icon={<Boxes className="h-6 w-6" />} title="Nenhum produto ainda" text="Cadastre seu primeiro produto digital para criar um checkout." action={<Button onClick={() => setEditing('new')}>Cadastrar produto</Button>} />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.data.map((p) => (
            <div key={p.id} className="flex gap-4 rounded-2xl border border-gray-200 bg-white p-4">
              {p.image_url ? <img src={p.image_url} alt="" className="h-20 w-20 shrink-0 rounded-xl object-cover" /> : <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-400"><Boxes className="h-6 w-6" /></div>}
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold leading-snug">{p.name}</p>
                  <Badge tone={p.active ? 'on' : 'off'}>{p.active ? 'Ativo' : 'Inativo'}</Badge>
                </div>
                <p className="mt-1 text-lg font-bold tabular-nums">{brl(p.price_cents)}</p>
                <p className="text-xs text-gray-500">Entrega: {{ link: 'link de acesso', file: 'arquivo', none: 'manual' }[p.delivery_type]}</p>
                <div className="mt-2 flex gap-1">
                  <Button size="sm" variant="secondary" onClick={() => setEditing(p)}><Pencil className="h-3.5 w-3.5" /> Editar</Button>
                  <Button size="sm" variant="ghost" aria-label="Excluir" onClick={() => confirm(`Excluir "${p.name}"?`) && remove.mutate(p.id, { onError: (e) => toast.err(e.message) })}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && (
        <ProductForm
          product={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (body) => {
            await save.mutateAsync(body);
            toast.ok('Produto salvo');
            setEditing(null);
          }}
        />
      )}
      {toast.node}
    </>
  );
}

function ProductForm({ product, onClose, onSave }: { product: Product | null; onClose: () => void; onSave: (b: any) => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, control, watch, formState } = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: product?.name ?? '',
      description: product?.description ?? '',
      price: centsToInput(product?.price_cents),
      image_url: product?.image_url ?? '',
      delivery_type: product?.delivery_type ?? 'link',
      delivery_url: product?.delivery_url ?? '',
      delivery_note: product?.delivery_note ?? '',
      active: product?.active ?? true,
    },
  });
  const type = watch('delivery_type');
  const e = formState.errors;

  return (
    <Modal open onClose={onClose} title={product ? 'Editar produto' : 'Novo produto'}>
      <form
        className="space-y-4"
        onSubmit={handleSubmit(async ({ price, ...v }) => {
          setError(null);
          try {
            await onSave({ ...v, id: product?.id, price_cents: parseMoney(price), description: v.description || null, delivery_url: v.delivery_url || null, delivery_note: v.delivery_note || null });
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Erro ao salvar');
          }
        })}
      >
        <Field label="Nome" error={e.name?.message}><Input {...register('name')} /></Field>
        <Field label="Descrição curta"><Textarea {...register('description')} rows={3} /></Field>
        <Field label="Preço (R$)" error={e.price?.message}><Input {...register('price')} inputMode="decimal" placeholder="97,00" /></Field>
        <Controller control={control} name="image_url" render={({ field }) => <ImageUpload label="Imagem do produto" value={field.value} onChange={field.onChange} />} />
        <Field label="Entrega">
          <Select {...register('delivery_type')}>
            <option value="link">Link de acesso (área de membros, Drive, etc.)</option>
            <option value="file">Arquivo (PDF, ZIP…) enviado ao Storage</option>
            <option value="none">Manual (sem link automático)</option>
          </Select>
        </Field>
        {type === 'link' && <Field label="Link de acesso" hint="Enviado por e-mail e mostrado após o pagamento"><Input {...register('delivery_url')} type="url" placeholder="https://" /></Field>}
        {type === 'file' && (
          <Controller control={control} name="delivery_url" render={({ field }) => <ImageUpload label="Arquivo do produto (privado, link temporário de 7 dias)" bucket="deliverables" accept="*/*" value={field.value} onChange={field.onChange} />} />
        )}
        <Field label="Instruções no e-mail de entrega (opcional)"><Textarea {...register('delivery_note')} rows={2} /></Field>
        <Controller control={control} name="active" render={({ field }) => <Switch checked={field.value} onChange={field.onChange} label="Produto ativo" />} />
        {error && <p className="text-sm font-medium text-red-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" loading={formState.isSubmitting}>Salvar</Button>
        </div>
      </form>
    </Modal>
  );
}
