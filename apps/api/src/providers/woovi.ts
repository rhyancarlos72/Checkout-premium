import { wooviConfig } from '../services/gateways.js';
import { fetchWithTimeout, HttpError, logger, onlyDigits } from '../lib/core.js';
import type { ChargeInfo, ChargeStatus, CreateChargeInput, CreatedCharge, PixProvider } from './types.js';

/**
 * Woovi / OpenPix — https://developers.woovi.com
 * Autenticação: header `Authorization: <AppID>`.
 * correlationID = ID do pedido → reenvio da mesma cobrança é idempotente.
 */
export class WooviProvider implements PixProvider {
  readonly name = 'woovi' as const;

  isConfigured() {
    return Boolean(wooviConfig().appId);
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const cfg = wooviConfig();
    if (!cfg.appId) throw new HttpError(503, 'Woovi não configurada');
    const res = await fetchWithTimeout(`${cfg.apiUrl}${path}`, {
      ...init,
      timeoutMs: 15000,
      headers: {
        Authorization: cfg.appId,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* resposta não-JSON */
    }
    if (!res.ok) {
      logger.warn({ status: res.status, path, error: json?.error }, 'Woovi API error');
      throw new HttpError(502, `Woovi respondeu ${res.status}: ${json?.error ?? 'erro desconhecido'}`);
    }
    return json as T;
  }

  async createCharge(input: CreateChargeInput): Promise<CreatedCharge> {
    const doc = onlyDigits(input.customer.document);
    const phone = onlyDigits(input.customer.phone);
    const body: Record<string, unknown> = {
      correlationID: input.orderId,
      value: input.amountCents,
      comment: input.description.slice(0, 140),
      expiresIn: input.expiresInSeconds,
      customer: {
        name: input.customer.name,
        email: input.customer.email,
        ...(doc.length === 11 || doc.length === 14 ? { taxID: doc } : {}),
        ...(phone.length >= 10 ? { phone: phone.startsWith('55') ? phone : `55${phone}` } : {}),
      },
    };
    const data = await this.call<{ charge: any }>('/api/v1/charge', { method: 'POST', body: JSON.stringify(body) });
    const c = data.charge;
    if (!c?.brCode) throw new HttpError(502, 'Resposta inválida da Woovi');
    return {
      chargeId: c.correlationID ?? input.orderId,
      pixCode: c.brCode,
      qrImage: c.qrCodeImage ?? null,
      expiresAt: c.expiresDate ? new Date(c.expiresDate) : new Date(Date.now() + input.expiresInSeconds * 1000),
    };
  }

  async getCharge(chargeId: string): Promise<ChargeInfo> {
    const data = await this.call<{ charge: any }>(`/api/v1/charge/${encodeURIComponent(chargeId)}`);
    const raw = String(data.charge?.status ?? '');
    const map: Record<string, ChargeStatus> = { ACTIVE: 'pending', COMPLETED: 'paid', EXPIRED: 'expired' };
    return {
      chargeId,
      status: map[raw] ?? 'unknown',
      paidAmountCents: typeof data.charge?.value === 'number' ? data.charge.value : undefined,
    };
  }

  /** Testa o AppID consultando a conta na Woovi. */
  async testConnection() {
    await this.call<any>('/api/v1/account/');
    return true;
  }
}
