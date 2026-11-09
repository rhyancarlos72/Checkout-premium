import { env } from '../config/env.js';
import { fetchWithTimeout, HttpError, logger } from '../lib/core.js';
import { efiConfig } from './gateways.js';

/**
 * Cartão de crédito pela Efí — API de Cobranças (dev.efipay.com.br/docs/api-cobrancas/cartao).
 * - O cartão é tokenizado NO NAVEGADOR pela biblioteca oficial (payment-token-efi): o servidor só recebe
 *   o payment_token e o tds_identifier (3DS). Número/CVV nunca passam por aqui.
 * - Autenticação: OAuth2 com Basic (Client_Id:Client_Secret) em POST /v1/authorize (sem certificado).
 * - Cobrança: POST /v1/charge/card (com 3DS). Status: approved/paid → pago; unpaid → recusado; waiting → em análise/desafio.
 * - Notificações: POST com o token em `notification` → GET /v1/notification/:token (a consulta confirma a origem).
 */
// EFI_COBRANCAS_URL: só para testes automatizados (Efí simulada)
const base = () => process.env.EFI_COBRANCAS_URL || (efiConfig().sandbox ? 'https://cobrancas-h.api.efipay.com.br' : 'https://cobrancas.api.efipay.com.br');
let token: { value: string; exp: number; key: string } | null = null;

async function accessToken() {
  const e = efiConfig();
  if (!e.clientId || !e.clientSecret) throw new HttpError(503, 'Efí não configurada');
  const key = `${e.clientId}|${e.sandbox}`;
  if (token && token.key === key && token.exp > Date.now()) return token.value;
  const res = await fetchWithTimeout(`${base()}/v1/authorize`, {
    method: 'POST',
    timeoutMs: 15000,
    headers: { Authorization: `Basic ${Buffer.from(`${e.clientId}:${e.clientSecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials' }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new HttpError(502, `Efí (Cobranças) recusou as credenciais: ${j.error_description ?? j.detail ?? res.status}. Ative a "API de Emissões" na sua aplicação Efí.`);
  token = { value: j.access_token, exp: Date.now() + (Number(j.expires_in) || 600) * 1000 - 60_000, key };
  return token.value;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetchWithTimeout(`${base()}${path}`, {
    method,
    timeoutMs: 20000,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let j: any = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    /* não-JSON */
  }
  if (!res.ok) {
    logger.warn({ status: res.status, path, err: j?.detail ?? j?.error_description }, 'Efí Cobranças: erro');
    throw new HttpError(res.status >= 500 ? 502 : 400, `Efí: ${j?.detail ?? j?.error_description ?? j?.title ?? `erro ${res.status}`}`);
  }
  return (j?.data ?? j) as T; // algumas rotas devolvem { code, data }, outras o objeto direto
}

export type EfiCardStatus = 'paid' | 'pending' | 'refused' | 'refunded' | 'chargeback' | 'canceled' | 'unknown';
/** Status da Efí → status do checkout. approved = aprovado pela operadora (o produto digital é liberado). */
export function mapEfiCardStatus(s: string | undefined): EfiCardStatus {
  switch (s) {
    case 'approved':
    case 'paid':
    case 'settled':
      return 'paid';
    case 'new':
    case 'waiting':
    case 'link':
      return 'pending';
    case 'unpaid':
      return 'refused';
    case 'refunded':
      return 'refunded';
    case 'contested':
      return 'chargeback';
    case 'canceled':
      return 'canceled';
    default:
      return 'unknown';
  }
}

export interface EfiCardInput {
  orderId: string;
  publicToken: string;
  description: string;
  totalCents: number;
  installments: number;
  paymentToken: string;
  tdsIdentifier: string;
  customer: { name: string; cpf: string; email: string; phone?: string | null };
  /** venda de produtor: parte dele (valor fixo) para a conta Efí dele (payee_code) */
  repasse?: { payeeCode: string; fixedCents: number } | null;
}

export interface EfiCardResult {
  chargeId: string;
  status: EfiCardStatus;
  raw: string;
  refusal?: string | null;
  challenge?: { action_url: string; creq: string; threeDSSessionData: string } | null;
}

export async function createEfiCardCharge(i: EfiCardInput): Promise<EfiCardResult> {
  const phone = (i.customer.phone ?? '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  const item: Record<string, unknown> = { name: i.description.slice(0, 255), value: i.totalCents, amount: 1 };
  // split no cartão (API Cobranças): repasse fixo exige mode 1 (a tarifa sai da conta que emite = Prime)
  if (i.repasse) item.marketplace = { mode: 1, repasses: [{ payee_code: i.repasse.payeeCode, fixed: i.repasse.fixedCents }] };
  const d: any = await call('POST', '/v1/charge/card', {
    items: [item],
    customer: { name: i.customer.name.slice(0, 255), cpf: i.customer.cpf, email: i.customer.email, ...(phone.length >= 10 ? { phone_number: phone } : {}) },
    installments: i.installments,
    payment_token: i.paymentToken,
    metadata: { custom_id: i.orderId, notification_url: `${env.PUBLIC_URL}/api/webhooks/efi-card` },
    tds_info: { tds_identifier: i.tdsIdentifier, challenge_callback_url: `${env.PUBLIC_URL}/api/public/orders/${i.publicToken}/3ds-return` },
  });
  const fd = d?.tds_challenge?.form_data;
  return {
    chargeId: String(d?.charge_id ?? ''),
    status: mapEfiCardStatus(d?.status),
    raw: String(d?.status ?? ''),
    refusal: d?.refusal?.reason ?? null,
    challenge: fd?.action_url ? { action_url: fd.action_url, creq: fd.creq, threeDSSessionData: fd.threeDSSessionData } : null,
  };
}

export async function getEfiCardCharge(chargeId: string) {
  const d: any = await call('GET', `/v1/charge/${encodeURIComponent(chargeId)}`);
  return { chargeId, status: mapEfiCardStatus(d?.status), raw: String(d?.status ?? ''), totalCents: typeof d?.total === 'number' ? d.total : undefined, reason: d?.reason ?? null };
}

/** Notificação: devolve o charge_id e o status mais recente (último item do histórico). */
export async function readEfiNotification(notificationToken: string) {
  const list: any[] = await call('GET', `/v1/notification/${encodeURIComponent(notificationToken)}`);
  const last = Array.isArray(list) ? list[list.length - 1] : null;
  return last ? { chargeId: String(last.identifiers?.charge_id ?? ''), status: mapEfiCardStatus(last.status?.current) } : null;
}
