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
    const card = input.method === 'card';
    // cartão na Woovi exige nome + CPF/CNPJ válidos do cliente (developers.woovi.com/docs/card)
    if (card && doc.length !== 11 && doc.length !== 14) throw new HttpError(400, 'Informe um CPF válido para pagar com cartão');
    // split (developers.woovi.com/docs/charge/how-to-create-charge-with-split-using-api): o valor de cada split vai
    // para a chave Pix informada; o restante (comissão da Prime) continua na conta que emitiu a cobrança
    const splits = input.split ? [{ pixKey: input.split.recipient.pixKey, value: input.split.producerCents }] : null;
    if (splits && (!splits[0].pixKey || splits[0].value <= 0)) throw new HttpError(400, 'Recebedor do produtor sem chave Pix para o split');
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
      ...(splits ? { splits } : {}),
      // cartão: só cartão (o Pix continua no nosso checkout); parcelas sem juros para o cliente
      ...(card ? { type: 'CREDIT_CARD', ...((input.cardInstallments ?? 1) > 1 ? { cardInstallments: input.cardInstallments } : {}) } : {}),
    };
    const data = await this.call<{ charge: any }>('/api/v1/charge', { method: 'POST', body: JSON.stringify(body) });
    const c = data.charge;
    if (card) {
      // página segura da Woovi onde o cliente digita o cartão (com 3DS); os dados nunca passam pelo nosso servidor
      const sf = await this.call<{ checkoutUrl?: string }>(`/api/v1/charge/${encodeURIComponent(input.orderId)}/card/smartform`, { method: 'POST' });
      if (!sf.checkoutUrl) throw new HttpError(502, 'A Woovi não retornou a página de pagamento com cartão');
      return {
        chargeId: c?.correlationID ?? input.orderId,
        pixCode: '',
        qrImage: null,
        expiresAt: c?.expiresDate ? new Date(c.expiresDate) : new Date(Date.now() + input.expiresInSeconds * 1000),
        cardUrl: sf.checkoutUrl,
        splitInfo: splits ? { gateway: 'woovi', splits } : null,
      };
    }
    if (!c?.brCode) throw new HttpError(502, 'Resposta inválida da Woovi');
    return {
      chargeId: c.correlationID ?? input.orderId,
      pixCode: c.brCode,
      qrImage: c.qrCodeImage ?? null,
      expiresAt: c.expiresDate ? new Date(c.expiresDate) : new Date(Date.now() + input.expiresInSeconds * 1000),
      splitInfo: splits ? { gateway: 'woovi', splits } : null,
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
