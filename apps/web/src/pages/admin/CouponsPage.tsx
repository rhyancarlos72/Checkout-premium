import { zodResolver } from '@hookform/resolvers/zod';
import { Pencil, Plus, Ticket, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, PageLoader, Select, Switch, useToast } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { brl, centsToInput, dateTime, parseMoney } from '@/lib/format';
import { PageHeader } from './AdminApp';
import { useCrud } from './crud';

interface Coupon {
  id: string;
  code: string;
  type: 'percent' | 'fixed';
  value: number;
  max_uses: number | null;
  used_count: number;
  min_cents: number;
  checkout_id: string | null;
  expires_at: string | null;
  active: boolean;
  checkout?: { name: string } | null;
}

const schema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,40}$/, 'Use 3+ letras, números, _ ou -'),
  type: z.enum(['percent', 'fixed']),
  value: z.string().min(1, 'Obrigatório'),
  max_uses: z.string().optional(),
  min: z.string().optional(),
  checkout_id: z.string().optional(),
  expires_at: z.string().optional(),
  active: z.boolean(),
});

export default function CouponsPage() {
  const { list, save, remove } = useCrud<Coupon>('coupons');
  const checkouts = useCrud<{ id: string; name: string }>('checkouts').list;
  const [editing, setEditing] = useState<Coupon | 'new' | null>(null);
  const toast = useToast();

  return (
    <>
      <PageHeader title="Cupons" subtitle="Descontos percentuais ou em valor fixo" action={<Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Novo cupom</Button>} />
      {list.isLoading ? (
        <PageLoader />
      ) : !list.data?.length ? (
        <Card><EmptyState icon={<Ticket className="h-6 w-6" />} title="Nenhum cupom" /></Card>
      ) : (
        <Card>
          <div className="-m-5 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-gray-100 text-left text-xs uppercase tracking-wide text-gray-500">
                <tr><th className="px-5 py-3 font-medium">Código</th><th className="px-5 py-3 font-medium">Desconto</th><th className="px-5 py-3 font-medium">Usos</th><th className="px-5 py-3 font-medium">Validade</th><th className="px-5 py-3 font-medium">Checkout</th><th className="px-5 py-3 font-medium">Status</th><th /></tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {list.data.map((c) => (
                  <tr key={c.id}>
                    <td className="px-5 py-3 font-mono font-semibold">{c.code}</td>
                    <td className="px-5 py-3">{c.type === 'percent' ? `${c.value}%` : brl(c.value)}</td>
                    <td className="px-5 py-3 tabular-nums">{c.used_count}{c.max_uses ? ` / ${c.max_uses}` : ''}</td>
                    <td className="px-5 py-3 text-gray-600">{c.expires_at ? dateTime(c.expires_at) : 'Sem validade'}</td>
                    <td className="px-5 py-3 text-gray-600">{c.checkout?.name ?? 'Todos'}</td>
                    <td className="px-5 py-3"><Badge tone={c.active ? 'on' : 'off'}>{c.active ? 'Ativo' : 'Inativo'}</Badge></td>
                    <td className="px-5 py-3 text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" aria-label="Editar" onClick={() => setEditing(c)}><Pencil className="h-4 w-4" /></Button>
                      <Button size="sm" variant="ghost" aria-label="Excluir" onClick={() => confirm(`Excluir cupom ${c.code}?`) && remove.mutate(c.id, { onError: (e) => toast.err(e.message) })}><Trash2 className="h-4 w-4" /></Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {editing && <CouponForm coupon={editing === 'new' ? null : editing} checkouts={checkouts.data ?? []} onClose={() => setEditing(null)} onSave={async (b) => { await save.mutateAsync(b); toast.ok('Cupom salvo'); setEditing(null); }} />}
      {toast.node}
    </>
  );
}

function toLocalInput(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function CouponForm({ coupon, checkouts, onClose, onSave }: { coupon: Coupon | null; checkouts: { id: string; name: string }[]; onClose: () => void; onSave: (b: any) => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, control, watch, formState } = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      code: coupon?.code ?? '',
      type: coupon?.type ?? 'percent',
      value: coupon ? (coupon.type === 'percent' ? String(coupon.value) : centsToInput(coupon.value)) : '',
      max_uses: coupon?.max_uses ? String(coupon.max_uses) : '',
      min: coupon?.min_cents ? centsToInput(coupon.min_cents) : '',
      checkout_id: coupon?.checkout_id ?? '',
      expires_at: toLocalInput(coupon?.expires_at ?? null),
      active: coupon?.active ?? true,
    },
  });
  const type = watch('type');
  const e = formState.errors;
  return (
    <Modal open onClose={onClose} title={coupon ? 'Editar cupom' : 'Novo cupom'}>
      <form
        className="space-y-4"
        onSubmit={handleSubmit(async (v) => {
          setError(null);
          const value = v.type === 'percent' ? Math.round(Number(v.value)) : parseMoney(v.value);
          if (!value || (v.type === 'percent' && value > 100)) return setError('Valor do desconto inválido');
          try {
            await onSave({
              id: coupon?.id,
              code: v.code,
              type: v.type,
              value,
              max_uses: v.max_uses ? Number(v.max_uses) : null,
              min_cents: v.min ? parseMoney(v.min) : 0,
              checkout_id: v.checkout_id || null,
              expires_at: v.expires_at ? new Date(v.expires_at).toISOString() : null,
              active: v.active,
            });
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Erro ao salvar');
          }
        })}
      >
        <Field label="Código" error={e.code?.message}><Input {...register('code')} autoCapitalize="characters" placeholder="BEMVINDO10" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tipo"><Select {...register('type')}><option value="percent">Percentual (%)</option><option value="fixed">Valor fixo (R$)</option></Select></Field>
          <Field label={type === 'percent' ? 'Desconto (%)' : 'Desconto (R$)'} error={e.value?.message}><Input {...register('value')} inputMode="decimal" /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Limite de usos"><Input {...register('max_uses')} inputMode="numeric" placeholder="Ilimitado" /></Field>
          <Field label="Pedido mínimo (R$)"><Input {...register('min')} inputMode="decimal" placeholder="0,00" /></Field>
        </div>
        <Field label="Válido até"><Input {...register('expires_at')} type="datetime-local" /></Field>
        <Field label="Restringir a um checkout">
          <Select {...register('checkout_id')}><option value="">Todos os checkouts</option>{checkouts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        </Field>
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
