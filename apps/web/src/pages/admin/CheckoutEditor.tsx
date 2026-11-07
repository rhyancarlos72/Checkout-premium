import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Check, ExternalLink, Eye, Monitor, MonitorSmartphone, Moon, RefreshCw, PenLine, Plus, Smartphone, Sun, Trash2, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ImageUpload } from '@/components/ImageUpload';
import { Button, cn, Field, Input, Select, Switch, Textarea } from '@/components/ui';
import { adminApi, ApiError } from '@/lib/api';
import { brl, centsToInput, parseMoney, productCode } from '@/lib/format';
import { checkoutPath, checkoutUrl } from '@/lib/links';
import { useMe } from '@/lib/me';
import { CheckoutView } from '../checkout/CheckoutView';
import { palettes, themeDefaults, type PublicCheckout, type Theme } from '../checkout/theme';
import type { Bump } from './BumpsPage';
import type { Product } from './ProductsPage';

export interface Checkout {
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
  product?: { name: string; price_cents: number; number?: number | null };
  checkout_bumps?: { bump_id: string; sort: number }[];
}

const slugify = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
/** Código numérico aleatório de 7 dígitos (ex.: 9452229) para /checkout?produto_id=… */
export const linkCode = () => String(1_000_000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9_000_000));
const tabs = ['Geral', 'Aparência', 'Conteúdo', 'Conversão', 'Ofertas', 'Rastreamento'] as const;

function Group({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className="space-y-4 border-b border-zinc-100 pb-6 last:border-0">
      <div>
        <h3 className="text-sm font-semibold text-zinc-900">{title}</h3>
        {desc && <p className="mt-0.5 text-xs text-zinc-500">{desc}</p>}
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[] }) {
  return (
    <div className="grid w-full rounded-xl bg-zinc-100 p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)} className={cn('flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition', value === o.value ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-800')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Moldura que renderiza o checkout real com escala (celular 390px / desktop 1280px). */
function PreviewFrame({ device, children }: { device: 'mobile' | 'desktop'; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 700 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const width = device === 'mobile' ? 390 : 1280;
  const height = device === 'mobile' ? 800 : 820;
  const scale = Math.min(1, (size.w - 32) / width, (size.h - 32) / height);
  return (
    <div ref={box} className="flex h-full w-full items-center justify-center overflow-hidden">
      <div style={{ width: width * scale, height: height * scale }} className="shrink-0">
        <div
          style={{ width, height, transform: `scale(${scale})`, transformOrigin: 'top left' }}
          className={cn('overflow-hidden bg-white shadow-2xl shadow-zinc-900/20 ring-1 ring-zinc-900/10', device === 'mobile' ? 'rounded-[44px] border-[10px] border-[#111214]' : 'rounded-xl')}
        >
          {device === 'desktop' && (
            <div className="flex h-9 items-center gap-1.5 border-b border-zinc-200 bg-zinc-100 px-4">
              {['bg-red-400', 'bg-amber-400', 'bg-emerald-400'].map((c) => <span key={c} className={cn('h-3 w-3 rounded-full', c)} />)}
              <span className="mx-auto rounded-md bg-white px-24 py-1 text-[11px] text-zinc-400">checkout</span>
            </div>
          )}
          <div className="h-full overflow-y-auto overscroll-contain [transform:translateZ(0)]" style={{ height: device === 'desktop' ? height - 36 : height - 20 }}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

export function CheckoutEditor({ checkout, products, bumps, onClose, onSave }: { checkout: Checkout | null; products: Product[]; bumps: Bump[]; onClose: () => void; onSave: (b: any) => Promise<void> }) {
  const [tab, setTab] = useState<(typeof tabs)[number]>('Geral');
  const [device, setDevice] = useState<'mobile' | 'desktop'>('mobile');
  const [mobileView, setMobileView] = useState<'edit' | 'preview'>('edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const globalGw = useMe().data?.defaultProvider ?? null;
  const [f, setF] = useState({
    name: checkout?.name ?? '',
    slug: checkout?.slug ?? linkCode(),
    product_id: checkout?.product_id ?? products[0]?.id ?? '',
    provider: checkout?.provider ?? (globalGw || 'woovi'),
    price: centsToInput(checkout?.price_cents),
    pix_expires_minutes: checkout?.pix_expires_minutes ?? 120,
    active: checkout?.active ?? true,
    fields: { phone: checkout?.fields?.phone ?? true, document: false },
    metaPixelId: checkout?.tracking?.metaPixelId ?? '',
  });
  const [theme, setTheme] = useState<Theme>({ ...themeDefaults, testimonials: [], ...checkout?.theme });
  // texto livre do preço “De”: não reformata enquanto digita
  const [compareInput, setCompareInput] = useState(centsToInput(checkout?.theme?.compareAtCents ?? null));
  const [bumpIds, setBumpIds] = useState<string[]>([...(checkout?.checkout_bumps ?? [])].sort((a, b) => a.sort - b.sort).map((b) => b.bump_id));
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => adminApi.get<{ store: { name: string; supportEmail: string; document: string } }>('/settings') });
  const set = (patch: Partial<typeof f>) => setF((p) => ({ ...p, ...patch }));
  const setT = (patch: Partial<Theme>) => setTheme((p) => ({ ...p, ...patch }));

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const product = products.find((p) => p.id === f.product_id);
  const previewData: PublicCheckout = useMemo(
    () => ({
      id: checkout?.id ?? 'preview',
      slug: f.slug || 'preview',
      name: f.name,
      price_cents: f.price ? parseMoney(f.price) : (product?.price_cents ?? 0),
      theme,
      fields: f.fields,
      tracking: { metaPixelId: null },
      product: { name: product?.name ?? 'Seu produto', description: product?.description ?? null, image_url: product?.image_url ?? null },
      bumps: bumpIds
        .map((id) => bumps.find((b) => b.id === id))
        .filter(Boolean)
        .map((b) => ({ id: b!.id, title: b!.title, description: b!.description, price_cents: b!.price_cents, compare_at_cents: b!.compare_at_cents, image_url: b!.image_url })),
      store: settings.data?.store ?? { name: 'Minha Loja', supportEmail: '', document: '' },
    }),
    [checkout?.id, f, theme, bumpIds, bumps, product, settings.data],
  );

  async function submit() {
    setError(null);
    if (!f.name || !f.slug || !f.product_id) {
      setTab('Geral');
      return setError('Preencha nome, endereço e produto.');
    }
    setBusy(true);
    try {
      await onSave({
        id: checkout?.id,
        name: f.name,
        slug: f.slug,
        product_id: f.product_id,
        provider: globalGw ?? f.provider,
        price_cents: f.price ? parseMoney(f.price) : null,
        pix_expires_minutes: Number(f.pix_expires_minutes),
        active: f.active,
        fields: f.fields,
        tracking: { metaPixelId: f.metaPixelId },
        theme: { ...theme, logoUrl: theme.logoUrl || null, bannerUrl: theme.bannerUrl || null, mockupUrl: theme.mockupUrl || null, testimonials: (theme.testimonials ?? []).filter((x) => x.name || x.text) },
        bump_ids: bumpIds,
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Erro ao salvar');
    } finally {
      setBusy(false);
    }
  }

  const move = (i: number, d: -1 | 1) =>
    setBumpIds((ids) => {
      const n = [...ids];
      [n[i], n[i + d]] = [n[i + d], n[i]];
      return n;
    });

  const colorInput = (value: string | undefined, onChange: (v: string) => void) => (
    <div className="flex gap-2">
      <label className="relative h-12 w-14 shrink-0 cursor-pointer overflow-hidden rounded-xl border border-zinc-300" style={{ background: value }}>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
      </label>
      <Input value={value ?? ''} onChange={(e) => onChange(e.target.value)} className="font-mono uppercase" maxLength={7} />
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-100">
      {/* Barra superior */}
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-zinc-200 bg-white px-3 sm:px-5">
        <button onClick={onClose} className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100" aria-label="Fechar editor"><X className="h-5 w-5" /></button>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{f.name || (checkout ? 'Editar checkout' : 'Novo checkout')}</p>
          <p className="truncate text-xs text-zinc-500">{checkoutUrl(f.slug || '…')}</p>
        </div>
        <div className="hidden items-center gap-2 sm:flex">
          <Switch checked={f.active} onChange={(v) => set({ active: v })} label={f.active ? 'Ativo' : 'Inativo'} />
          {checkout && (
            <a href={checkoutPath(checkout.slug)} target="_blank" rel="noreferrer" className="ml-2 inline-flex h-10 items-center gap-2 rounded-xl border border-zinc-200 px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50">
              <ExternalLink className="h-4 w-4" /> Abrir
            </a>
          )}
        </div>
        <Button onClick={submit} loading={busy}><Check className="h-4 w-4" /> Salvar</Button>
      </header>

      {/* Alternância editar / visualizar (celular) */}
      <div className="flex shrink-0 border-b border-zinc-200 bg-white p-2 lg:hidden">
        <Segmented value={mobileView} onChange={setMobileView} options={[{ value: 'edit', label: <><PenLine className="h-4 w-4" /> Editar</> }, { value: 'preview', label: <><Eye className="h-4 w-4" /> Visualizar</> }]} />
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Painel de configuração */}
        <aside className={cn('flex w-full min-w-0 flex-col border-r border-zinc-200 bg-white lg:w-[440px] lg:shrink-0', mobileView === 'preview' && 'hidden lg:flex')}>
          <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-zinc-100 px-3 [scrollbar-width:none]">
            {tabs.map((t) => (
              <button key={t} onClick={() => setTab(t)} className={cn('whitespace-nowrap border-b-2 px-3 py-3.5 text-sm font-medium transition', tab === t ? 'border-zinc-900 text-zinc-900' : 'border-transparent text-zinc-500 hover:text-zinc-800')}>{t}</button>
            ))}
          </nav>
          <div className="flex-1 space-y-6 overflow-y-auto p-5">
            {error && <p className="rounded-xl bg-red-50 px-3 py-2.5 text-sm font-medium text-red-700">{error}</p>}

            {tab === 'Geral' && (
              <>
                <Group title="Identificação">
                  <Field label="Nome interno"><Input value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="Ex.: Curso X — página principal" /></Field>
                  <Field label="Código do link" hint={checkoutUrl(f.slug || '…')}>
                    <div className="flex gap-2">
                      <Input value={f.slug} onChange={(e) => set({ slug: slugify(e.target.value) })} className="font-mono" />
                      <Button type="button" variant="secondary" className="h-12 shrink-0" title="Gerar novo código" onClick={() => set({ slug: linkCode() })}><RefreshCw className="h-4 w-4" /></Button>
                    </div>
                  </Field>
                </Group>
                <Group title="Produto e preço">
                  <Field label="Produto principal">
                    <Select value={f.product_id} onChange={(e) => set({ product_id: e.target.value })}>{products.map((p) => <option key={p.id} value={p.id}>{p.number ? `ID: ${productCode(p.number)} · ` : ''}{p.name} — {brl(p.price_cents)}</option>)}</Select>
                  </Field>
                  <Field label="Preço neste checkout" hint="Deixe vazio para usar o preço do produto"><Input value={f.price} onChange={(e) => set({ price: e.target.value })} inputMode="decimal" placeholder={product ? centsToInput(product.price_cents) : '97,00'} /></Field>
                </Group>
                <Group title="Pagamento">
                  {globalGw ? (
                    <Field label="Gateway PIX">
                      <p className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5 text-sm text-blue-800">
                        Todos os produtos usam <b>{globalGw === 'efi' ? 'Efí Bank' : 'Woovi'}</b>. Para escolher por checkout, mude em <Link to="/admin/integracoes" className="font-semibold underline">Integrações</Link>.
                      </p>
                    </Field>
                  ) : (
                    <Field label="Gateway PIX">
                      <Segmented value={f.provider} onChange={(v) => set({ provider: v })} options={[{ value: 'woovi', label: 'Woovi' }, { value: 'efi', label: 'Efí Bank' }]} />
                    </Field>
                  )}
                  <Field label="Validade do PIX (minutos)" hint="Padrão: 120 min (2 horas)"><Input type="number" min={5} max={1440} value={f.pix_expires_minutes} onChange={(e) => set({ pix_expires_minutes: Number(e.target.value) })} /></Field>
                </Group>
                <Group title="Campos do comprador" desc="Menos campos = mais conversão. Nome e e-mail são sempre pedidos; CPF não é pedido.">
                  <div className="flex flex-col gap-3">
                    <Switch checked={f.fields.phone} onChange={(v) => set({ fields: { ...f.fields, phone: v } })} label="Celular / WhatsApp" />
                    <div className="sm:hidden"><Switch checked={f.active} onChange={(v) => set({ active: v })} label="Checkout ativo" /></div>
                  </div>
                </Group>
              </>
            )}

            {tab === 'Aparência' && (
              <>
                <Group title="Tema">
                  <Segmented value={theme.mode ?? 'light'} onChange={(v) => setT({ mode: v, backgroundColor: v === 'dark' ? '#0a0b10' : v === 'light' ? '#f4f5f7' : undefined })} options={[{ value: 'light', label: <><Sun className="h-4 w-4" /> Claro</> }, { value: 'dark', label: <><Moon className="h-4 w-4" /> Escuro</> }, { value: 'auto', label: <><MonitorSmartphone className="h-4 w-4" /> Auto</> }]} />
                  {theme.mode === 'auto' && <p className="text-xs text-zinc-500">Segue o modo (claro/escuro) do celular ou computador do comprador.</p>}
                </Group>
                <Group title="Cor da marca" desc="Usada no botão, destaques e ofertas.">
                  <div className="flex flex-wrap gap-2">
                    {palettes.map((p) => (
                      <button key={p.color} type="button" title={p.name} onClick={() => setT({ primaryColor: p.color })} className={cn('h-9 w-9 rounded-full ring-offset-2 transition hover:scale-110', theme.primaryColor === p.color && 'ring-2 ring-zinc-900')} style={{ background: p.color }} aria-label={p.name} />
                    ))}
                  </div>
                  {colorInput(theme.primaryColor, (v) => setT({ primaryColor: v }))}
                </Group>
                <Group title="Cor de fundo">{colorInput(theme.backgroundColor, (v) => setT({ backgroundColor: v }))}</Group>
                <Group title="Cantos">
                  <Segmented value={theme.radius ?? 'soft'} onChange={(v) => setT({ radius: v })} options={[{ value: 'sharp', label: 'Retos' }, { value: 'soft', label: 'Suaves' }, { value: 'round', label: 'Redondos' }]} />
                </Group>
                <Group title="Imagens" desc="Banner: 1600×900 px recomendado. Logo: PNG com fundo transparente.">
                  <ImageUpload label="Logo" value={theme.logoUrl} onChange={(v) => setT({ logoUrl: v })} />
                  <ImageUpload label="Banner" value={theme.bannerUrl} onChange={(v) => setT({ bannerUrl: v })} />
                  <ImageUpload label="Mockup do produto (usado se não houver banner)" value={theme.mockupUrl} onChange={(v) => setT({ mockupUrl: v })} />
                </Group>
              </>
            )}

            {tab === 'Conteúdo' && (
              <>
                <Group title="Textos principais">
                  <Field label="Título" hint="Vazio = nome do produto"><Input value={theme.headline ?? ''} onChange={(e) => setT({ headline: e.target.value })} /></Field>
                  <Field label="Subtítulo" hint="Vazio = descrição do produto"><Textarea rows={2} value={theme.subheadline ?? ''} onChange={(e) => setT({ subheadline: e.target.value })} /></Field>
                  <Field label="Texto do botão"><Input value={theme.buttonText ?? ''} onChange={(e) => setT({ buttonText: e.target.value })} placeholder="Finalizar compra" /></Field>
                  <Field label="Nome do produtor / marca" hint="Aparece como “por …” abaixo do título"><Input value={theme.producerName ?? ''} onChange={(e) => setT({ producerName: e.target.value })} placeholder="Ex.: Prof. Ana Lima" /></Field>
                  <Field label="Preço “De” (riscado)" hint="Mostra “De R$ X por R$ Y” e o selo de desconto"><Input value={compareInput} onChange={(e) => { const v = e.target.value; setCompareInput(v); setT({ compareAtCents: v.trim() ? parseMoney(v) || null : null }); }} onBlur={() => setCompareInput(centsToInput(theme.compareAtCents ?? null))} inputMode="decimal" placeholder="Ex.: 197,00" /></Field>
                </Group>
                <Group title="Benefícios" desc="Lista com ✓ no card do produto. Até 8 itens curtos.">
                  {(theme.benefits ?? []).map((b, i) => (
                    <div key={i} className="flex gap-2">
                      <Input value={b} onChange={(e) => setT({ benefits: theme.benefits!.map((x, j) => (j === i ? e.target.value : x)) })} placeholder="Ex.: Acesso vitalício" className="h-10" />
                      <Button variant="ghost" size="sm" className="h-10" aria-label="Remover" onClick={() => setT({ benefits: theme.benefits!.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                  ))}
                  <Button variant="secondary" size="sm" disabled={(theme.benefits?.length ?? 0) >= 8} onClick={() => setT({ benefits: [...(theme.benefits ?? []), ''] })}><Plus className="h-4 w-4" /> Adicionar benefício</Button>
                </Group>
                <Group title="Garantia">
                  <Field label="Dias de garantia (0 oculta)"><Input type="number" min={0} max={365} value={theme.guaranteeDays ?? 7} onChange={(e) => setT({ guaranteeDays: Number(e.target.value) })} /></Field>
                  <Field label="Texto da garantia"><Textarea rows={2} value={theme.guaranteeText ?? ''} onChange={(e) => setT({ guaranteeText: e.target.value })} placeholder="Se não gostar por qualquer motivo, devolvemos 100% do seu dinheiro." /></Field>
                </Group>
                <Group title="Depoimentos" desc="Até 6. Use depoimentos reais de clientes.">
                  {(theme.testimonials ?? []).map((tm, i) => (
                    <div key={i} className="space-y-2 rounded-xl border border-zinc-200 p-3">
                      <div className="flex gap-2">
                        <Input placeholder="Nome" value={tm.name} onChange={(e) => setT({ testimonials: theme.testimonials!.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} className="h-10" />
                        <Button variant="ghost" size="sm" className="h-10" aria-label="Remover" onClick={() => setT({ testimonials: theme.testimonials!.filter((_, j) => j !== i) })}><Trash2 className="h-4 w-4" /></Button>
                      </div>
                      <Textarea rows={2} placeholder="Depoimento" value={tm.text} onChange={(e) => setT({ testimonials: theme.testimonials!.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} />
                    </div>
                  ))}
                  <Button variant="secondary" size="sm" disabled={(theme.testimonials?.length ?? 0) >= 6} onClick={() => setT({ testimonials: [...(theme.testimonials ?? []), { name: '', text: '' }] })}><Plus className="h-4 w-4" /> Adicionar depoimento</Button>
                </Group>
                <Group title="Rodapé"><Textarea rows={3} value={theme.footerText ?? ''} onChange={(e) => setT({ footerText: e.target.value })} placeholder="CNPJ, termos de uso, política de privacidade…" /></Group>
              </>
            )}

            {tab === 'Conversão' && (
              <>
                <Group title="Barra de anúncio" desc="Faixa no topo com a cor da marca.">
                  <Input value={theme.announcement ?? ''} onChange={(e) => setT({ announcement: e.target.value })} placeholder="Ex.: Bônus exclusivo para os 50 primeiros" />
                </Group>
                <Group title="Cronômetro de oferta">
                  <Switch checked={!!theme.showTimer} onChange={(v) => setT({ showTimer: v })} label="Mostrar cronômetro" />
                  {theme.showTimer && (
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Minutos"><Input type="number" min={1} max={120} value={theme.timerMinutes ?? 15} onChange={(e) => setT({ timerMinutes: Number(e.target.value) })} /></Field>
                      <Field label="Texto"><Input value={theme.timerText ?? ''} onChange={(e) => setT({ timerText: e.target.value })} placeholder="Oferta reservada por" /></Field>
                    </div>
                  )}
                  {(theme.showTimer || theme.announcement) && (
                    <div className="space-y-3">
                      <div>
                        <p className="mb-2 text-sm font-medium text-zinc-700">Cor da barra do cronômetro</p>
                        <div className="flex flex-wrap gap-2">
                          {[
                            { c: null, label: 'Cor principal' },
                            { c: '#dc2626', label: 'Vermelho' },
                            { c: '#111827', label: 'Preto' },
                            { c: '#f59e0b', label: 'Amarelo' },
                            { c: '#ea580c', label: 'Laranja' },
                            { c: '#16a34a', label: 'Verde' },
                            { c: '#7c3aed', label: 'Roxo' },
                          ].map((o) => {
                            const on = (theme.timerBgColor ?? null) === o.c;
                            return (
                              <button key={o.label} type="button" title={o.label} onClick={() => setT({ timerBgColor: o.c, timerTextColor: null })} className={cn('flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition', on ? 'border-blue-600 ring-2 ring-blue-600/20' : 'border-zinc-200 hover:border-zinc-300')}>
                                <span className="h-4 w-4 rounded-full ring-1 ring-black/10" style={{ background: o.c ?? (theme.primaryColor || '#16a34a') }} />
                                {o.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <Field label="Fundo (personalizado)">{colorInput(theme.timerBgColor ?? (theme.primaryColor || '#16a34a'), (v) => setT({ timerBgColor: v }))}</Field>
                        <Field label="Texto" hint="Vazio = automático (contraste)">
                          <div className="flex gap-2">
                            {colorInput(theme.timerTextColor ?? '#ffffff', (v) => setT({ timerTextColor: v }))}
                            {theme.timerTextColor && <Button type="button" variant="ghost" className="h-12 shrink-0" onClick={() => setT({ timerTextColor: null })}>Auto</Button>}
                          </div>
                        </Field>
                      </div>
                    </div>
                  )}
                </Group>
                <Group title="Confiança e celular">
                  <div className="flex flex-col gap-3">
                    <Switch checked={theme.showSeals !== false} onChange={(v) => setT({ showSeals: v })} label="Selos de segurança abaixo do botão" />
                    <Switch checked={theme.stickyMobileCta !== false} onChange={(v) => setT({ stickyMobileCta: v })} label="Botão de pagar fixo no celular" />
                  </div>
                </Group>
              </>
            )}

            {tab === 'Ofertas' && (
              <Group title="Produtos adicionais (order bumps)" desc="Outros produtos oferecidos com 1 clique antes do botão. A ordem aqui é a ordem no checkout. Também dá para configurar no card do produto, em Produtos.">
                {bumps.length === 0 ? (
                  <p className="rounded-xl bg-zinc-50 p-4 text-sm text-zinc-500">Nenhum order bump cadastrado. Crie em “Order bumps” no menu.</p>
                ) : (
                  <>
                    <div className="space-y-2">
                      {bumpIds.map((id, i) => {
                        const b = bumps.find((x) => x.id === id);
                        if (!b) return null;
                        return (
                          <div key={id} className="flex items-center gap-2 rounded-xl border border-zinc-900 bg-zinc-50 px-3 py-2.5 text-sm">
                            <span className="w-5 text-center text-xs font-bold text-zinc-400">{i + 1}</span>
                            <span className="min-w-0 flex-1 truncate font-medium">{b.title}</span>
                            <span className="pv tabular-nums text-zinc-600">{brl(b.price_cents)}</span>
                            <button disabled={i === 0} onClick={() => move(i, -1)} className="p-1 text-zinc-500 disabled:opacity-30" aria-label="Subir"><ArrowUp className="h-4 w-4" /></button>
                            <button disabled={i === bumpIds.length - 1} onClick={() => move(i, 1)} className="p-1 text-zinc-500 disabled:opacity-30" aria-label="Descer"><ArrowDown className="h-4 w-4" /></button>
                            <button onClick={() => setBumpIds(bumpIds.filter((x) => x !== id))} className="p-1 text-zinc-500 hover:text-red-600" aria-label="Remover"><Trash2 className="h-4 w-4" /></button>
                          </div>
                        );
                      })}
                    </div>
                    {bumps.some((b) => !bumpIds.includes(b.id)) && <p className="pt-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">Disponíveis</p>}
                    {bumps.filter((b) => !bumpIds.includes(b.id)).map((b) => (
                      <button key={b.id} onClick={() => setBumpIds([...bumpIds, b.id])} className="flex w-full items-center gap-3 rounded-xl border border-dashed border-zinc-300 px-3 py-2.5 text-left text-sm transition hover:border-zinc-500 hover:bg-zinc-50">
                        <Plus className="h-4 w-4 text-zinc-400" />
                        <span className="min-w-0 flex-1 truncate">{b.title}{!b.active && <span className="ml-2 text-xs text-zinc-400">(inativo)</span>}</span>
                        <span className="pv tabular-nums text-zinc-600">{brl(b.price_cents)}</span>
                      </button>
                    ))}
                  </>
                )}
              </Group>
            )}

            {tab === 'Rastreamento' && (
              <Group title="Meta Pixel" desc="Dispara PageView, InitiateCheckout e Purchase com o mesmo event_id enviado ao PayTracking (deduplicação).">
                <Input value={f.metaPixelId} onChange={(e) => set({ metaPixelId: e.target.value.replace(/\D/g, '') })} inputMode="numeric" placeholder="ID do pixel (só números)" />
                <p className="rounded-xl bg-zinc-50 p-3 text-xs leading-relaxed text-zinc-600">UTMs, fbclid, gclid, fbp/fbc e src/sck da URL são capturados automaticamente e salvos em cada pedido.</p>
              </Group>
            )}
          </div>
        </aside>

        {/* Pré-visualização ao vivo */}
        <section className={cn('relative min-w-0 flex-1 flex-col', mobileView === 'edit' ? 'hidden lg:flex' : 'flex')}>
          <div className="flex shrink-0 items-center justify-center gap-3 px-5 py-3 sm:justify-between">
            <p className="hidden items-center gap-2 text-sm font-medium text-zinc-600 sm:flex"><span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" /><span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" /></span> Pré-visualização ao vivo</p>
            <div className="w-52"><Segmented value={device} onChange={setDevice} options={[{ value: 'mobile', label: <><Smartphone className="h-4 w-4" /> Celular</> }, { value: 'desktop', label: <><Monitor className="h-4 w-4" /> Desktop</> }]} /></div>
          </div>
          <div className="min-h-0 flex-1 bg-[radial-gradient(circle_at_1px_1px,#d4d4d8_1px,transparent_0)] [background-size:20px_20px]">
            {product ? (
              <PreviewFrame device={device}>
                <CheckoutView key={device + (theme.mode ?? '')} checkout={previewData} preview />
              </PreviewFrame>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-zinc-500">Cadastre um produto para ver a prévia.</div>
            )}
          </div>
        </section>
      </div>
    </div>,
    document.body,
  );
}
