import { ImageUpload } from '@/components/ImageUpload';
import { ArrowDown, ArrowUp, Copy, CreditCard, ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, cn, EmptyState, Field, Input, Modal, PageLoader, Select, Switch, Textarea, useToast } from '@/components/ui';
import { ApiError } from '@/lib/api';
import { brl, centsToInput, contrastText, parseMoney } from '@/lib/format';
import type { Theme } from '../checkout/CheckoutPage';
import { PageHeader } from './AdminApp';
import type { Bump } from './BumpsPage';
import { useCrud } from './crud';
import type { Product } from './ProductsPage';

interface Checkout {
  id: string;
  slug: string;
  name: string;
  product_id: string;
  provider: 'woovi' | 'efi';
  price_cents: number | null;
  theme: Theme;
  fields: { phone: boolean; document: boolean };
  tracking: { metaPixelId?: string };
  pix_expires_minutes: number;
  active: boolean;
  product?: { name: string; price_cents: number };
  checkout_bumps?: { bump_id: string; sort: number }[];
}

const slugify = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

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
        <div className="grid gap-4 md:grid-cols-2">
          {list.data.map((c) => (
            <div key={c.id} className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
              <div className="h-2" style={{ background: c.theme?.primaryColor || '#0f766e' }} />
              <div className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{c.name}</p>
                    <p className="truncate text-sm text-gray-500">{c.product?.name} · {brl(c.price_cents ?? c.product?.price_cents ?? 0)}</p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <Badge tone="off">{c.provider === 'efi' ? 'Efí' : 'Woovi'}</Badge>
                    <Badge tone={c.active ? 'on' : 'off'}>{c.active ? 'Ativo' : 'Inativo'}</Badge>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2 rounded-xl bg-gray-50 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-gray-600">{url(c.slug)}</span>
                  <button className="text-gray-500 hover:text-gray-900" aria-label="Copiar link" onClick={() => navigator.clipboard.writeText(url(c.slug)).then(() => toast.ok('Link copiado'))}><Copy className="h-4 w-4" /></button>
                  <a className="text-gray-500 hover:text-gray-900" href={url(c.slug)} target="_blank" rel="noreferrer" aria-label="Abrir"><ExternalLink className="h-4 w-4" /></a>
                </div>
                <div className="mt-3 flex gap-1">
                  <Button size="sm" variant="secondary" onClick={() => setEditing(c)}><Pencil className="h-3.5 w-3.5" /> Editar</Button>
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

const tabs = ['Geral', 'Visual', 'Order bumps', 'Rastreamento'] as const;

function CheckoutEditor({ checkout, products, bumps, onClose, onSave }: { checkout: Checkout | null; products: Product[]; bumps: Bump[]; onClose: () => void; onSave: (b: any) => Promise<void> }) {
  const [tab, setTab] = useState<(typeof tabs)[number]>('Geral');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({
    name: checkout?.name ?? '',
    slug: checkout?.slug ?? '',
    product_id: checkout?.product_id ?? products[0]?.id ?? '',
    provider: checkout?.provider ?? 'woovi',
    price: centsToInput(checkout?.price_cents),
    pix_expires_minutes: checkout?.pix_expires_minutes ?? 30,
    active: checkout?.active ?? true,
    fields: checkout?.fields ?? { phone: true, document: true },
    metaPixelId: checkout?.tracking?.metaPixelId ?? '',
  });
  const [theme, setTheme] = useState<Theme>({
    primaryColor: '#0f766e',
    backgroundColor: '#f5f6f8',
    buttonText: 'Pagar com PIX',
    guaranteeDays: 7,
    showTimer: false,
    timerMinutes: 15,
    testimonials: [],
    ...checkout?.theme,
  });
  const [bumpIds, setBumpIds] = useState<string[]>(
    [...(checkout?.checkout_bumps ?? [])].sort((a, b) => a.sort - b.sort).map((b) => b.bump_id),
  );
  const set = (patch: Partial<typeof f>) => setF((p) => ({ ...p, ...patch }));
  const setT = (patch: Partial<Theme>) => setTheme((p) => ({ ...p, ...patch }));

  async function submit() {
    setError(null);
    if (!f.name || !f.slug || !f.product_id) return setError('Preencha nome, endereço e produto');
    setBusy(true);
    try {
      await onSave({
        id: checkout?.id,
        name: f.name,
        slug: f.slug,
        product_id: f.product_id,
        provider: f.provider,
        price_cents: f.price ? parseMoney(f.price) : null,
        pix_expires_minutes: Number(f.pix_expires_minutes),
        active: f.active,
        fields: f.fields,
        tracking: { metaPixelId: f.metaPixelId },
        theme: { ...theme, logoUrl: theme.logoUrl || null, bannerUrl: theme.bannerUrl || null, mockupUrl: theme.mockupUrl || null },
        bump_ids: bumpIds,
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao salvar');
    } finally {
      setBusy(false);
    }
  }

  const move = (i: number, d: -1 | 1) => setBumpIds((ids) => {
    const n = [...ids];
    [n[i], n[i + d]] = [n[i + d], n[i]];
    return n;
  });

  return (
    <Modal open onClose={onClose} title={checkout ? 'Editar checkout' : 'Novo checkout'} wide>
      <div className="-mx-5 -mt-5 mb-5 flex gap-1 overflow-x-auto border-b border-gray-100 px-5">
        {tabs.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={cn('whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium', tab === t ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-800')}>{t}</button>
        ))}
      </div>

      {tab === 'Geral' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nome interno"><Input value={f.name} onChange={(e) => set({ name: e.target.value, ...(!checkout && { slug: slugify(e.target.value) }) })} /></Field>
          <Field label="Endereço do checkout" hint={`${window.location.origin}/c/${f.slug || '...'}`}><Input value={f.slug} onChange={(e) => set({ slug: slugify(e.target.value) })} /></Field>
          <Field label="Produto principal">
            <Select value={f.product_id} onChange={(e) => set({ product_id: e.target.value })}>{products.map((p) => <option key={p.id} value={p.id}>{p.name} — {brl(p.price_cents)}</option>)}</Select>
          </Field>
          <Field label="Preço neste checkout (opcional)" hint="Vazio = preço do produto"><Input value={f.price} onChange={(e) => set({ price: e.target.value })} inputMode="decimal" placeholder="Ex.: 47,00" /></Field>
          <Field label="Gateway PIX">
            <Select value={f.provider} onChange={(e) => set({ provider: e.target.value as any })}><option value="woovi">Woovi (OpenPix)</option><option value="efi">Efí Bank</option></Select>
          </Field>
          <Field label="Validade do PIX (minutos)"><Input type="number" min={5} max={1440} value={f.pix_expires_minutes} onChange={(e) => set({ pix_expires_minutes: Number(e.target.value) })} /></Field>
          <div className="space-y-3 sm:col-span-2">
            <p className="text-sm font-medium text-gray-700">Campos do comprador</p>
            <div className="flex flex-wrap gap-6">
              <Switch checked={f.fields.phone} onChange={(v) => set({ fields: { ...f.fields, phone: v } })} label="Pedir celular" />
              <Switch checked={f.fields.document} onChange={(v) => set({ fields: { ...f.fields, document: v } })} label="Pedir CPF/CNPJ" />
              <Switch checked={f.active} onChange={(v) => set({ active: v })} label="Checkout ativo" />
            </div>
          </div>
        </div>
      )}

      {tab === 'Visual' && (
        <div className="grid gap-5 lg:grid-cols-[1fr_260px]">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Cor principal">
              <div className="flex gap-2"><input type="color" value={theme.primaryColor} onChange={(e) => setT({ primaryColor: e.target.value })} className="h-12 w-14 cursor-pointer rounded-xl border border-gray-300 bg-white p-1" /><Input value={theme.primaryColor} onChange={(e) => setT({ primaryColor: e.target.value })} /></div>
            </Field>
            <Field label="Cor de fundo">
              <div className="flex gap-2"><input type="color" value={theme.backgroundColor} onChange={(e) => setT({ backgroundColor: e.target.value })} className="h-12 w-14 cursor-pointer rounded-xl border border-gray-300 bg-white p-1" /><Input value={theme.backgroundColor} onChange={(e) => setT({ backgroundColor: e.target.value })} /></div>
            </Field>
            <Field label="Título (headline)" className="sm:col-span-2"><Input value={theme.headline ?? ''} onChange={(e) => setT({ headline: e.target.value })} placeholder="Nome do produto por padrão" /></Field>
            <Field label="Texto do botão"><Input value={theme.buttonText ?? ''} onChange={(e) => setT({ buttonText: e.target.value })} /></Field>
            <Field label="Garantia (dias, 0 oculta)"><Input type="number" min={0} value={theme.guaranteeDays ?? 7} onChange={(e) => setT({ guaranteeDays: Number(e.target.value) })} /></Field>
            <Field label="Texto da garantia" className="sm:col-span-2"><Input value={theme.guaranteeText ?? ''} onChange={(e) => setT({ guaranteeText: e.target.value })} /></Field>
            <ImageUpload label="Logo" value={theme.logoUrl} onChange={(v) => setT({ logoUrl: v })} />
            <ImageUpload label="Banner (topo / lateral)" value={theme.bannerUrl} onChange={(v) => setT({ bannerUrl: v })} />
            <ImageUpload label="Mockup (usado se não houver banner)" value={theme.mockupUrl} onChange={(v) => setT({ mockupUrl: v })} />
            <div className="space-y-2">
              <Switch checked={!!theme.showTimer} onChange={(v) => setT({ showTimer: v })} label="Cronômetro de oferta" />
              {theme.showTimer && <Input type="number" min={1} max={120} value={theme.timerMinutes ?? 15} onChange={(e) => setT({ timerMinutes: Number(e.target.value) })} />}
            </div>
            <Field label="Rodapé (CNPJ, termos, contato)" className="sm:col-span-2"><Textarea rows={2} value={theme.footerText ?? ''} onChange={(e) => setT({ footerText: e.target.value })} /></Field>
            <div className="sm:col-span-2">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-medium text-gray-700">Depoimentos</p>
                <Button size="sm" variant="secondary" disabled={(theme.testimonials?.length ?? 0) >= 6} onClick={() => setT({ testimonials: [...(theme.testimonials ?? []), { name: '', text: '' }] })}><Plus className="h-3.5 w-3.5" /> Adicionar</Button>
              </div>
              <div className="space-y-2">
                {theme.testimonials?.map((tm, i) => (
                  <div key={i} className="flex gap-2">
                    <Input className="w-36" placeholder="Nome" value={tm.name} onChange={(e) => setT({ testimonials: theme.testimonials!.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                    <Input placeholder="Depoimento" value={tm.text} onChange={(e) => setT({ testimonials: theme.testimonials!.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} />
                    <Button variant="ghost" aria-label="Remover" onClick={() => setT({ testimonials: theme.testimonials!.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                ))}
              </div>
            </div>
          </div>
          {/* Pré-visualização rápida */}
          <div className="hidden lg:block">
            <p className="mb-2 text-sm font-medium text-gray-700">Pré-visualização</p>
            <div className="sticky top-20 overflow-hidden rounded-2xl border border-gray-200 text-[11px]" style={{ background: theme.backgroundColor }}>
              <div className="flex h-8 items-center bg-white px-3 font-semibold">{theme.logoUrl ? <img src={theme.logoUrl} className="h-4" alt="" /> : 'Sua loja'}</div>
              {(theme.bannerUrl || theme.mockupUrl) && <img src={theme.bannerUrl || theme.mockupUrl || ''} alt="" className="aspect-video w-full object-cover" />}
              <div className="space-y-2 p-3">
                <div className="rounded-lg bg-white p-2.5 font-semibold">{theme.headline || products.find((p) => p.id === f.product_id)?.name}</div>
                <div className="space-y-1.5 rounded-lg bg-white p-2.5">
                  <div className="h-5 rounded border border-gray-200" /><div className="h-5 rounded border border-gray-200" />
                </div>
                <div className="rounded-lg py-2 text-center font-semibold" style={{ background: theme.primaryColor, color: contrastText(theme.primaryColor || '#0f766e') }}>{theme.buttonText || 'Pagar com PIX'}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'Order bumps' && (
        <div className="space-y-4">
          {bumps.length === 0 ? (
            <p className="text-sm text-gray-500">Nenhum order bump cadastrado. Crie em “Order bumps”.</p>
          ) : (
            <>
              <div className="space-y-2">
                {bumpIds.map((id, i) => {
                  const b = bumps.find((x) => x.id === id);
                  if (!b) return null;
                  return (
                    <div key={id} className="flex items-center gap-3 rounded-xl border border-gray-900 bg-gray-50 px-3 py-2.5 text-sm">
                      <span className="w-5 text-center font-semibold text-gray-500">{i + 1}</span>
                      <span className="flex-1 font-medium">{b.title}</span>
                      <span className="tabular-nums">{brl(b.price_cents)}</span>
                      <button disabled={i === 0} onClick={() => move(i, -1)} className="p-1 text-gray-500 disabled:opacity-30" aria-label="Subir"><ArrowUp className="h-4 w-4" /></button>
                      <button disabled={i === bumpIds.length - 1} onClick={() => move(i, 1)} className="p-1 text-gray-500 disabled:opacity-30" aria-label="Descer"><ArrowDown className="h-4 w-4" /></button>
                      <button onClick={() => setBumpIds(bumpIds.filter((x) => x !== id))} className="p-1 text-gray-500" aria-label="Remover"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  );
                })}
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium text-gray-700">Disponíveis</p>
                {bumps.filter((b) => !bumpIds.includes(b.id)).map((b) => (
                  <button key={b.id} onClick={() => setBumpIds([...bumpIds, b.id])} className="flex w-full items-center gap-3 rounded-xl border border-dashed border-gray-300 px-3 py-2.5 text-left text-sm hover:border-gray-500">
                    <Plus className="h-4 w-4 text-gray-400" />
                    <span className="flex-1">{b.title}{!b.active && <span className="ml-2 text-xs text-gray-400">(inativo)</span>}</span>
                    <span className="tabular-nums text-gray-600">{brl(b.price_cents)}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'Rastreamento' && (
        <div className="space-y-4">
          <Field label="ID do Pixel da Meta (opcional)" hint="Dispara PageView, InitiateCheckout e Purchase no navegador com o mesmo event_id enviado ao PayTracking (deduplicação).">
            <Input value={f.metaPixelId} onChange={(e) => set({ metaPixelId: e.target.value.replace(/\D/g, '') })} inputMode="numeric" placeholder="123456789012345" />
          </Field>
          <p className="rounded-xl bg-gray-50 p-3 text-sm text-gray-600">UTMs (utm_source, utm_campaign…), fbclid, fbp/fbc e src/sck da URL são capturados automaticamente e salvos no pedido.</p>
        </div>
      )}

      {error && <p className="mt-4 text-sm font-medium text-red-600">{error}</p>}
      <div className="mt-6 flex justify-end gap-2 border-t border-gray-100 pt-4">
        <Button variant="secondary" onClick={onClose}>Cancelar</Button>
        <Button loading={busy} onClick={submit}>Salvar checkout</Button>
      </div>
    </Modal>
  );
}
