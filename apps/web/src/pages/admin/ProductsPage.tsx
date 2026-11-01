import { ImageUpload } from '@/components/ImageUpload';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Boxes, Check, Copy, CopyPlus, ExternalLink, Link2, Palette, Pencil, Plus, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, PageLoader, Select, Switch, Textarea, useToast } from '@/components/ui';
import { adminApi, ApiError } from '@/lib/api';
import { brl, centsToInput, parseMoney } from '@/lib/format';
import { PageHeader } from './AdminApp';
import { useCrud } from './crud';

export interface Product {
  id: string;
  /** ID numérico próprio (#1001…) */
  number?: number;
  name: string;
  description: string | null;
  price_cents: number;
  image_url: string | null;
  delivery_type: 'link' | 'file' | 'none';
  delivery_url: string | null;
  delivery_note: string | null;
  active: boolean;
  checkouts?: { id: string; slug: string; name: string; active: boolean }[];
}

/** Link de checkout do produto, com copiar/abrir. */
function ProductLink({ product, onCreated }: { product: Product; onCreated: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const create = useMutation({ mutationFn: () => adminApi.post(`/products/${product.id}/checkout`), onSuccess: onCreated });
  const links = (product.checkouts ?? []).map((c) => ({ ...c, url: `${window.location.origin}/c/${c.slug}` }));
  if (!links.length)
    return (
      <Button size="sm" variant="brand" className="w-full" loading={create.isPending} onClick={() => create.mutate()} style={{ ['--brand' as any]: '#059669' }}>
        <Link2 className="h-4 w-4" /> Gerar link de checkout
      </Button>
    );
  return (
    <div className="space-y-1.5">
      {links.map((l) => (
        <div key={l.id} className="flex items-center gap-1 rounded-xl border border-emerald-200 bg-emerald-50/60 py-1 pl-3 pr-1">
          <Link2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-emerald-900" title={l.url}>/c/{l.slug}</span>
          {!l.active && <span className="shrink-0 rounded bg-zinc-200 px-1.5 text-[10px] font-semibold text-zinc-600">inativo</span>}
          <button
            className="flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-emerald-700 hover:bg-white"
            onClick={() => navigator.clipboard.writeText(l.url).then(() => (setCopied(l.id), setTimeout(() => setCopied(null), 1500)))}
          >
            {copied === l.id ? <><Check className="h-3.5 w-3.5" /> Copiado</> : <><Copy className="h-3.5 w-3.5" /> Copiar</>}
          </button>
          <a href={l.url} target="_blank" rel="noreferrer" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-emerald-700 hover:bg-white" aria-label="Abrir checkout"><ExternalLink className="h-3.5 w-3.5" /></a>
        </div>
      ))}
    </div>
  );
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
  const qc = useQueryClient();
  const navigate = useNavigate();
  const duplicate = useMutation({
    mutationFn: (id: string) => adminApi.post<any>(`/products/${id}/duplicate`),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['products'] });
      qc.invalidateQueries({ queryKey: ['checkouts'] });
      toast.ok(`Duplicado${r?.number ? ` como #${r.number}` : ''} · link /c/${r?.checkout?.slug ?? ''}`);
    },
    onError: (e) => toast.err(e.message),
  });

  return (
    <>
      <PageHeader title="Produtos" subtitle="Cada produto tem seu próprio link de checkout, criado automaticamente" action={<Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Novo produto</Button>} />
      {list.isLoading ? (
        <PageLoader />
      ) : !list.data?.length ? (
        <Card>
          <EmptyState icon={<Boxes className="h-6 w-6" />} title="Nenhum produto ainda" text="Cadastre seu primeiro produto digital para criar um checkout." action={<Button onClick={() => setEditing('new')}>Cadastrar produto</Button>} />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.data.map((p) => (
            <div key={p.id} className="flex flex-col gap-4 rounded-2xl border border-zinc-200/70 bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,.04),0_8px_24px_-12px_rgba(16,24,40,.08)]">
              <div className="flex gap-4">
                {p.image_url ? <img src={p.image_url} alt="" className="h-20 w-20 shrink-0 rounded-xl object-cover" /> : <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl bg-zinc-100 text-zinc-400"><Boxes className="h-6 w-6" /></div>}
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      {p.number && <span className="mb-1 inline-block rounded-md bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-zinc-600">ID #{p.number}</span>}
                      <p className="font-semibold leading-snug">{p.name}</p>
                    </div>
                    <Badge tone={p.active ? 'on' : 'off'}>{p.active ? 'Ativo' : 'Inativo'}</Badge>
                  </div>
                  <p className="mt-1 text-lg font-bold tabular-nums">{brl(p.price_cents)}</p>
                  <p className="text-xs text-zinc-500">Entrega: {{ link: 'link de acesso', file: 'arquivo', none: 'manual' }[p.delivery_type]}</p>
                </div>
              </div>
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Link de checkout</p>
                <ProductLink product={p} onCreated={() => (qc.invalidateQueries({ queryKey: ['products'] }), qc.invalidateQueries({ queryKey: ['checkouts'] }), toast.ok('Link criado'))} />
              </div>
              <div className="mt-auto flex flex-wrap items-center gap-1 whitespace-nowrap border-t border-zinc-100 pt-3">
                <Button size="sm" variant="secondary" onClick={() => setEditing(p)}><Pencil className="h-3.5 w-3.5" /> Editar</Button>
                <Button size="sm" variant="ghost" onClick={() => navigate('/admin/checkouts')}><Palette className="h-3.5 w-3.5" /> Personalizar</Button>
                <Button size="sm" variant="ghost" loading={duplicate.isPending && duplicate.variables === p.id} onClick={() => duplicate.mutate(p.id)} title="Duplicar produto e checkout"><CopyPlus className="h-3.5 w-3.5" /> Duplicar</Button>
                <span className="flex-1" />
                <Button size="sm" variant="ghost" aria-label="Excluir" onClick={() => confirm(`Excluir "${p.name}"?`) && remove.mutate(p.id, { onError: (e) => toast.err(e.message) })}>
                  <Trash2 className="h-4 w-4" />
                </Button>
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
            const saved: any = await save.mutateAsync(body);
            qc.invalidateQueries({ queryKey: ['checkouts'] });
            toast.ok(saved?.checkout ? `Produto${saved.number ? ` #${saved.number}` : ''} criado · link /c/${saved.checkout.slug}` : 'Produto salvo');
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
    <Modal open onClose={onClose} title={product ? `Editar produto${product.number ? ` · ID #${product.number}` : ''}` : 'Novo produto'}>
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
