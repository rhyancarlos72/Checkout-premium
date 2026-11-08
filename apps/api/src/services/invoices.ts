import { z } from 'zod';
import { fetchWithTimeout, logger, onlyDigits, phoneE164BR, supabase } from '../lib/core.js';

/**
 * Notas fiscais via Spedy (https://docs.spedy.com.br) — porta do `enviar_nota_fiscal.php`.
 *  - NFS-e (serviço): POST /v1/service-invoices
 *  - NF-e (produto):  POST /v1/product-invoices
 * Regras:
 *  - UMA nota por venda: produto principal + order bumps somados num único valor.
 *  - Só pedido pago. Trava no banco (invoices.order_id único): webhooks repetidos nunca geram 2 notas.
 *  - A chave da API fica só no banco (settings "invoices", visível apenas ao dono) e aparece mascarada.
 */

export const invoiceSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  type: z.enum(['service', 'product']).default('service'),
  apiKey: z.string().trim().max(200).default(''),
  apiUrl: z.string().url().default('https://api.spedy.com.br/v1'),
  /** valor descontado da nota (taxa bancária), em centavos — o PHP descontava R$ 0,50 */
  deductCents: z.number().int().min(0).max(100_00).default(50),
  sendEmailToCustomer: z.boolean().default(false),
  description: z.string().trim().max(200).default('Conteúdo digital disponibilizado por meio eletrônico.'),
  service: z
    .object({
      federalServiceCode: z.string().trim().max(20).default('1.09'),
      cnaeCode: z.string().trim().max(20).default('74.10-2/99'),
      taxationInMunicipality: z.string().trim().max(40).default('nonIncidence'),
      taxLocation: z.string().trim().max(60).default('serviceProvisionMunicipality'),
      cityName: z.string().trim().max(80).default(''),
      cityState: z.string().trim().max(2).default(''),
    })
    .default({ federalServiceCode: '1.09', cnaeCode: '74.10-2/99', taxationInMunicipality: 'nonIncidence', taxLocation: 'serviceProvisionMunicipality', cityName: '', cityState: '' }),
  product: z
    .object({
      operationNature: z.string().trim().max(60).default('Venda de mercadoria'),
      cfop: z.string().trim().max(4).default('5102'),
      ncm: z.string().trim().max(8).default('49011000'),
      icmsCst: z.string().trim().max(3).default('102'),
      pisCst: z.string().trim().max(2).default('99'),
      cofinsCst: z.string().trim().max(2).default('99'),
      additionalInformation: z.string().trim().max(300).default('Infoproduto digital. Entrega realizada via e-mail e download.'),
      // endereço padrão do comprador (o checkout não pede endereço)
      street: z.string().trim().max(80).default(''),
      number: z.string().trim().max(10).default('SN'),
      district: z.string().trim().max(60).default('Centro'),
      postalCode: z.string().trim().max(9).default(''),
      city: z.string().trim().max(60).default(''),
      state: z.string().trim().max(2).default(''),
    })
    .default({ operationNature: 'Venda de mercadoria', cfop: '5102', ncm: '49011000', icmsCst: '102', pisCst: '99', cofinsCst: '99', additionalInformation: 'Infoproduto digital. Entrega realizada via e-mail e download.', street: '', number: 'SN', district: 'Centro', postalCode: '', city: '', state: '' }),
});
export type InvoiceSettings = z.infer<typeof invoiceSettingsSchema>;

const KEY = 'invoices';
let cache: { value: InvoiceSettings; at: number } | null = null;
export async function getInvoiceSettings(): Promise<InvoiceSettings> {
  if (cache && Date.now() - cache.at < 15_000) return cache.value;
  const { data } = await supabase.from('settings').select('value').eq('key', KEY).maybeSingle();
  const value = invoiceSettingsSchema.parse((data as any)?.value ?? {});
  cache = { value, at: Date.now() };
  return value;
}
export async function saveInvoiceSettings(input: unknown) {
  const cur = await getInvoiceSettings();
  const raw = invoiceSettingsSchema.parse(input);
  const value = { ...raw, apiKey: raw.apiKey || cur.apiKey }; // chave vazia = mantém a salva
  if (value.enabled && !value.apiKey) throw Object.assign(new Error('Informe a chave da API Spedy para ativar a emissão'), { status: 400 });
  const { error } = await supabase.from('settings').upsert({ key: KEY, value, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
  cache = null;
  return value;
}

// ------------------------------------------------------------------ payloads
/**
 * Datas no MESMO formato do sistema PHP antigo, que já emitia sem erro nesta conta Spedy:
 *  - NFS-e: date("Y-m-d\\TH:i:s.v\\Z") → horário de Brasília com sufixo "Z" (a Spedy lê como UTC e
 *    converte para Brasília, ficando ~3 h antes do processamento: nunca "no futuro").
 *    Com a hora real em UTC, a Spedy convertia e a DPS saía alguns segundos À FRENTE do Emissor
 *    Nacional → "A data de emissão da DPS não pode ser posterior à data do seu processamento".
 *  - NF-e: date("Y-m-d\\TH:i:sP") → horário de Brasília com -03:00.
 */
const brWall = (at: number) => new Date(at - 3 * 3600_000).toISOString(); // relógio de Brasília (sem horário de verão)
export const issueDateNfse = (at = Date.now()) => brWall(at - 60_000); // 1 min de folga
export const issueDateNfe = (at = Date.now()) => `${brWall(at - 60_000).slice(0, 19)}-03:00`;
/** @deprecated mantido para compatibilidade */
export const issueDateBR = issueDateNfe;
export interface InvoiceOrder {
  id: string;
  number: number;
  total_cents: number;
  customer: { name: string; email: string; phone: string | null; document: string | null } | null;
  items: { kind: string; name: string; price_cents: number }[];
}

const brl = (cents: number) => Math.max(0, Math.round(cents) / 100);

/** Descrição única da venda: "Produto + Bônus A + Bônus B". */
export function saleDescription(o: InvoiceOrder) {
  const main = o.items.find((i) => i.kind === 'main') ?? o.items[0];
  const extras = o.items.filter((i) => i !== main).map((i) => i.name);
  return [main?.name ?? 'Produto digital', ...extras].join(' + ');
}

/** Valor da nota = total da venda (produto + bumps − desconto) − dedução configurada. */
export const invoiceAmountCents = (o: InvoiceOrder, s: InvoiceSettings) => Math.max(0, o.total_cents - s.deductCents);

export function buildServicePayload(o: InvoiceOrder, s: InvoiceSettings) {
  const now = issueDateNfse();
  const amount = brl(invoiceAmountCents(o, s));
  const doc = onlyDigits(o.customer?.document);
  return {
    integrationId: o.id, // idempotência na Spedy: a mesma venda nunca vira duas notas
    amount,
    description: `${saleDescription(o).slice(0, 120)} - ${s.description}`.slice(0, 2000),
    federalServiceCode: s.service.federalServiceCode,
    cnaeCode: s.service.cnaeCode,
    issuedOn: now,
    effectiveDate: now,
    batchNumber: '',
    taxationInMunicipality: s.service.taxationInMunicipality,
    taxLocation: s.service.taxLocation,
    sendEmailToCustomer: s.sendEmailToCustomer,
    receiver: {
      name: (o.customer?.name ?? '').trim().slice(0, 115),
      federalTaxNumber: doc || null,
      email: o.customer?.email?.trim() ?? '',
      phoneNumber: phoneE164BR(o.customer?.phone) ?? '',
      address: { street: '', number: '', district: '', postalCode: '', city: { name: '', state: '' } },
    },
    total: { issBaseTax: 0, irRate: 0, pisRate: 0, cofinsRate: 0, inssAmount: 0, othersAmount: 0, invoiceAmount: amount },
    ...(s.service.cityName ? { location: { name: s.service.cityName, state: s.service.cityState.toUpperCase() } } : {}),
  };
}

export function buildProductPayload(o: InvoiceOrder, s: InvoiceSettings) {
  const amount = brl(invoiceAmountCents(o, s));
  const p = s.product;
  const zero = { baseValue: 0, rate: 0, value: 0 };
  return {
    integrationId: o.id,
    issuedOn: issueDateNfe(),
    operationType: 'outgoing',
    purposeType: 'normal',
    issueType: 'normal',
    destination: 'internal',
    presenceType: '2',
    printingType: '1',
    operationNature: p.operationNature,
    isFinalCustomer: true,
    receiver: {
      name: (o.customer?.name ?? '').trim().slice(0, 60),
      federalTaxNumber: onlyDigits(o.customer?.document),
      email: o.customer?.email?.trim() ?? '',
      phoneNumber: phoneE164BR(o.customer?.phone) ?? '',
      address: { street: p.street, number: p.number, district: p.district, postalCode: onlyDigits(p.postalCode), city: { name: p.city, state: p.state.toUpperCase() } },
    },
    // uma linha só: a venda inteira (produto + order bumps) conta como UMA venda
    items: [
      {
        description: saleDescription(o).slice(0, 120),
        quantity: 1,
        price: amount,
        amount,
        commercialUnit: 'UN',
        tributaryUnit: 'UN',
        cfop: p.cfop,
        ncm: p.ncm,
        taxation: { type: 'simplesNFe', icms: { cst: p.icmsCst, ...zero }, pis: { cst: p.pisCst, ...zero }, cofins: { cst: p.cofinsCst, ...zero } },
      },
    ],
    total: { productsValue: amount, invoiceValue: amount },
    payments: [{ type: 'pix', value: amount }],
    additionalInformation: p.additionalInformation,
  };
}

// ------------------------------------------------------------------ API Spedy
async function spedy(s: InvoiceSettings, method: string, path: string, body?: unknown, timeoutMs = 30_000) {
  const res = await fetchWithTimeout(`${s.apiUrl.replace(/\/+$/, '')}${path}`, {
    method,
    headers: { 'X-Api-Key': s.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs,
  });
  const raw = await res.text();
  let json: any = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    /* não-JSON */
  }
  return { ok: res.ok, status: res.status, json, raw };
}

const endpoint = (type: 'service' | 'product') => (type === 'product' ? '/product-invoices' : '/service-invoices');

/** Tradução do status da Spedy para o nosso. */
export function mapSpedyStatus(st: unknown): 'processing' | 'issued' | 'error' | 'canceled' {
  const v = String(st ?? '').toLowerCase();
  if (['authorized', 'issued', 'approved', 'autorizada', 'emitida'].includes(v)) return 'issued';
  if (['canceled', 'cancelled', 'cancelada'].includes(v)) return 'canceled';
  if (['rejected', 'error', 'denied', 'failed', 'rejeitada', 'erro'].includes(v)) return 'error';
  return 'processing';
}
function spedyMessage(json: any, raw: string) {
  const d = json?.processingDetail;
  const m = (typeof d === 'string' ? d : d?.message ?? d?.description) ?? json?.message ?? json?.title ?? json?.errors ?? raw;
  return (typeof m === 'string' ? m : JSON.stringify(m)).slice(0, 500);
}
const numberOf = (j: any) => {
  const n = j?.number ?? j?.invoiceNumber ?? j?.rpsNumber ?? null;
  return n && String(n) !== '0' ? String(n) : null; // nº 0 = ainda não numerada pela prefeitura
};

async function loadOrder(orderId: string) {
  const { data } = await supabase
    .from('orders')
    .select('id, number, status, total_cents, customer:customers(name, email, phone, document), items:order_items(kind, name, price_cents)')
    .eq('id', orderId)
    .maybeSingle();
  return data as (InvoiceOrder & { status: string }) | null;
}

/**
 * Emite a nota de um pedido pago. Seguro para chamar várias vezes:
 * a linha em `invoices` (order_id único) é a trava; nota já emitida/em processamento não é refeita.
 * `retry` permite reemitir uma nota que deu erro.
 */
export async function emitInvoice(orderId: string, opts: { retry?: boolean; manual?: boolean } = {}) {
  const s = await getInvoiceSettings();
  if (!opts.manual && !s.enabled) return { ok: false, message: 'Emissão automática desativada' };
  if (!s.apiKey) return { ok: false, message: 'Informe a chave da API Spedy em Integrações → Notas fiscais' };
  const o = await loadOrder(orderId);
  if (!o) return { ok: false, message: 'Pedido não encontrado' };
  if (o.status !== 'paid') return { ok: false, message: 'Só pedidos pagos recebem nota fiscal' };

  const amount = invoiceAmountCents(o, s);
  // trava: cria a linha; se já existir, só segue quando for nova tentativa de uma nota com erro
  const claim = await supabase.from('invoices').insert({ order_id: o.id, type: s.type, amount_cents: amount, status: 'processing' }).select('id').maybeSingle();
  if (claim.error) {
    if (!/duplicate|unique/i.test(claim.error.message)) return { ok: false, message: claim.error.message };
    if (!opts.retry) return { ok: false, message: 'Este pedido já tem nota fiscal' };
    const { data: reclaimed } = await supabase
      .from('invoices')
      .update({ status: 'processing', type: s.type, amount_cents: amount, message: null, updated_at: new Date().toISOString() })
      .eq('order_id', o.id)
      .eq('status', 'error')
      .select('id');
    if (!reclaimed?.length) return { ok: false, message: 'A nota deste pedido já foi emitida ou está em processamento' };
  }

  const payload = s.type === 'product' ? buildProductPayload(o, s) : buildServicePayload(o, s);
  try {
    const r = await spedy(s, 'POST', endpoint(s.type), payload);
    const { data: cur } = await supabase.from('invoices').select('attempts').eq('order_id', o.id).maybeSingle();
    const attempts = ((cur as any)?.attempts ?? 0) + 1;
    if (r.ok && r.json?.id) {
      const status = mapSpedyStatus(r.json.status);
      await supabase
        .from('invoices')
        .update({ provider_id: String(r.json.id), status, number: numberOf(r.json), message: status === 'error' ? spedyMessage(r.json, r.raw) : null, response: r.json, attempts, updated_at: new Date().toISOString() })
        .eq('order_id', o.id);
      await logInvoice(o.id, true, `nota criada na Spedy (${s.type === 'product' ? 'NF-e' : 'NFS-e'}) · ${status}`);
      return { ok: true, message: status === 'issued' ? 'Nota fiscal emitida' : 'Nota enviada; aguardando autorização' };
    }
    const message = r.status === 401 || r.status === 403 ? 'Chave da API Spedy recusada (confira em Integrações → Notas fiscais)' : `Spedy respondeu ${r.status}: ${spedyMessage(r.json, r.raw)}`;
    await supabase.from('invoices').update({ status: 'error', message, response: r.json ?? { raw: r.raw.slice(0, 2000) }, attempts, updated_at: new Date().toISOString() }).eq('order_id', o.id);
    await logInvoice(o.id, false, message);
    return { ok: false, message };
  } catch (e: any) {
    const message = `Falha de conexão com a Spedy: ${e?.message ?? e}`;
    await supabase.from('invoices').update({ status: 'error', message, updated_at: new Date().toISOString() }).eq('order_id', o.id);
    await logInvoice(o.id, false, message);
    return { ok: false, message };
  }
}

async function logInvoice(orderId: string, ok: boolean, message: string) {
  await supabase.from('integration_logs').insert({ integration: 'spedy', order_id: orderId, event: 'invoice', ok, message: message.slice(0, 500) });
}

/** Atualiza notas em processamento (autorização da prefeitura/SEFAZ é assíncrona). */
export async function refreshPendingInvoices(max = 20) {
  const s = await getInvoiceSettings();
  if (!s.apiKey) return;
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const { data } = await supabase.from('invoices').select('order_id, type, provider_id').eq('status', 'processing').not('provider_id', 'is', null).gt('created_at', since).limit(max);
  for (const inv of (data ?? []) as any[]) await refreshInvoice(inv.order_id, inv.type, inv.provider_id, s).catch((e) => logger.warn({ err: e?.message }, 'Spedy: consulta falhou'));
}
export async function refreshInvoice(orderId: string, type: 'service' | 'product', providerId: string, sIn?: InvoiceSettings) {
  const s = sIn ?? (await getInvoiceSettings());
  const r = await spedy(s, 'GET', `${endpoint(type)}/${encodeURIComponent(providerId)}`);
  if (!r.ok || !r.json) return null;
  const status = mapSpedyStatus(r.json.status);
  await supabase
    .from('invoices')
    .update({ status, number: numberOf(r.json), message: status === 'error' ? spedyMessage(r.json, r.raw) : null, response: r.json, updated_at: new Date().toISOString() })
    .eq('order_id', orderId);
  return status;
}

/** Baixa PDF/XML da nota pela Spedy (a chave nunca vai para o navegador). */
export async function invoiceFile(orderId: string, kind: 'pdf' | 'xml') {
  const s = await getInvoiceSettings();
  const { data } = await supabase.from('invoices').select('type, provider_id').eq('order_id', orderId).maybeSingle();
  const inv = data as any;
  if (!inv?.provider_id) return null;
  const res = await fetchWithTimeout(`${s.apiUrl.replace(/\/+$/, '')}${endpoint(inv.type)}/${encodeURIComponent(inv.provider_id)}/${kind}`, { headers: { 'X-Api-Key': s.apiKey }, timeoutMs: 30_000 });
  if (!res.ok) return null;
  return { body: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') ?? (kind === 'pdf' ? 'application/pdf' : 'application/xml') };
}

/** Testa a chave listando 1 nota. */
export async function testSpedy(sIn?: Partial<InvoiceSettings>) {
  const cur = await getInvoiceSettings();
  const s = { ...cur, ...sIn, apiKey: sIn?.apiKey || cur.apiKey };
  if (!s.apiKey) return { ok: false, message: 'Informe a chave da API Spedy' };
  try {
    const r = await spedy(s as InvoiceSettings, 'GET', `${endpoint(s.type === 'product' ? 'product' : 'service')}?page=1&pageSize=1`, undefined, 15_000);
    if (r.ok) return { ok: true, message: `Conexão com a Spedy OK · chave aceita (${s.type === 'product' ? 'NF-e' : 'NFS-e'})` };
    if (r.status === 401 || r.status === 403) return { ok: false, message: `Chave da API recusada pela Spedy (HTTP ${r.status}). Copie de novo a chave em Spedy → Configurações → API.` };
    // a Spedy respondeu e não reclamou da chave: autenticação OK, só a listagem não foi aceita
    if (r.status === 400 || r.status === 404 || r.status === 405) return { ok: true, message: `Spedy respondeu e aceitou a chave (HTTP ${r.status} na listagem de teste)` };
    return { ok: false, message: `Spedy respondeu ${r.status}: ${spedyMessage(r.json, r.raw)}` };
  } catch (e: any) {
    return { ok: false, message: e?.name === 'AbortError' ? 'A Spedy não respondeu em 15 segundos. Tente de novo em instantes.' : `Falha de conexão com a Spedy: ${e?.message ?? e}` };
  }
}

