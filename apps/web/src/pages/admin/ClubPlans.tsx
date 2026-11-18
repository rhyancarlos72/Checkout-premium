import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button, cn, Input } from '@/components/ui';
import { adminApi, ApiError } from '@/lib/api';
import { brl, parseMoney } from '@/lib/format';

interface Plan { id: string; name: string; price_cents: number; on_sale: boolean; active_subscribers: number }

/**
 * Planos do Clube (ex.: Fundador R$ 9,90 e Padrão R$ 19,90).
 * "À venda" = o preço que o checkout cobra de quem assinar agora; quem já assina continua no preço do plano dele.
 */
export function ClubPlans({ productId }: { productId: string }) {
  const qc = useQueryClient();
  const key = ['club-plans', productId];
  const { data, error } = useQuery({ queryKey: key, queryFn: () => adminApi.get<Plan[]>(`/club/plans?product_id=${productId}`) });
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const done = (text: string) => (setMsg({ ok: true, text }), qc.invalidateQueries({ queryKey: key }));
  const fail = (e: unknown) => setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Erro' });
  const add = useMutation({
    mutationFn: () => adminApi.post<Plan>('/club/plans', { product_id: productId, name: name.trim(), price_cents: parseMoney(price), on_sale: !data?.length }),
    onSuccess: () => (setName(''), setPrice(''), done('Plano criado')),
    onError: fail,
  });
  const sale = useMutation({ mutationFn: (id: string) => adminApi.post<{ message: string }>(`/club/plans/${id}/on-sale`), onSuccess: (r) => done(r.message), onError: fail });
  const del = useMutation({ mutationFn: (id: string) => adminApi.del(`/club/plans/${id}`), onSuccess: () => done('Plano removido'), onError: fail });

  return (
    <div className="space-y-2 rounded-lg bg-white/80 p-3 ring-1 ring-emerald-200">
      <p className="text-xs font-semibold uppercase tracking-wide text-emerald-900">Planos</p>
      {error && <p className="text-xs text-red-600">{error instanceof ApiError ? error.message : 'Erro ao carregar os planos'}</p>}
      {(data ?? []).map((p) => (
        <div key={p.id} className={cn('flex items-center gap-2 rounded-lg border px-2.5 py-2 text-sm', p.on_sale ? 'border-emerald-400 bg-emerald-50' : 'border-zinc-200')}>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-zinc-900">{p.name} · <span className="pv">{brl(p.price_cents)}/mês</span></p>
            <p className="text-[11px] text-zinc-500">{p.active_subscribers} assinante{p.active_subscribers === 1 ? '' : 's'} ativo{p.active_subscribers === 1 ? '' : 's'} neste preço</p>
          </div>
          {p.on_sale ? (
            <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" /> À venda</span>
          ) : (
            <Button type="button" size="sm" variant="secondary" loading={sale.isPending && sale.variables === p.id} onClick={() => confirm(`Colocar "${p.name}" à venda? Novos assinantes passam a pagar ${brl(p.price_cents)}/mês; quem já assina continua no preço dele.`) && sale.mutate(p.id)}>Colocar à venda</Button>
          )}
          {!p.on_sale && !p.active_subscribers && (
            <Button type="button" size="sm" variant="ghost" aria-label="Remover plano" onClick={() => confirm(`Remover o plano "${p.name}"?`) && del.mutate(p.id)}><Trash2 className="h-4 w-4" /></Button>
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-2 pt-1">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome (ex.: Fundador)" className="h-10 min-w-[140px] flex-1" />
        <Input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="R$/mês (ex.: 9,90)" className="h-10 w-36" />
        <Button type="button" size="sm" className="h-10" disabled={name.trim().length < 2 || parseMoney(price) < 100} loading={add.isPending} onClick={() => add.mutate()}><Plus className="h-4 w-4" /> Adicionar plano</Button>
      </div>
      {msg && <p className={cn('text-xs font-medium', msg.ok ? 'text-emerald-700' : 'text-red-600')}>{msg.text}</p>}
    </div>
  );
}
