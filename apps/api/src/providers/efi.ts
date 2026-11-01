import https from 'node:https';
import { efiConfig } from '../services/gateways.js';
import { HttpError, centsToBRL, isValidCnpj, isValidCpf, logger, onlyDigits } from '../lib/core.js';
import type { ChargeInfo, ChargeStatus, CreateChargeInput, CreatedCharge, PixProvider } from './types.js';

/**
 * Efí Bank — API Pix (https://dev.efipay.com.br/docs/api-pix)
 * Requer mTLS com o certificado .p12 da aplicação. O certificado NUNCA fica no
 * repositório: vem de EFI_CERT_BASE64 (variável de ambiente) ou EFI_CERT_PATH.
 * txid = ID do pedido sem hífens (32 chars) → idempotente.
 */
export class EfiProvider implements PixProvider {
  readonly name = 'efi' as const;
  private agent: https.Agent | null = null;
  private agentKey = '';
  private token: { value: string; exp: number } | null = null;

  private get baseUrl() {
    return efiConfig().sandbox ? 'https://pix-h.api.efipay.com.br' : 'https://pix.api.efipay.com.br';
  }

  isConfigured() {
    return efiConfig().configured;
  }

  private getAgent(): https.Agent {
    const cfg = efiConfig();
    if (!cfg.configured || !cfg.pfx) throw new HttpError(503, 'Efí não configurada');
    // credenciais/certificado mudaram no painel → novo agente mTLS e novo token
    if (this.agent && this.agentKey === cfg.key) return this.agent;
    this.agent?.destroy();
    this.agent = new https.Agent({ pfx: cfg.pfx, passphrase: cfg.passphrase, keepAlive: true });
    this.agentKey = cfg.key;
    this.token = null;
    return this.agent;
  }

  private request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = https.request(
        url,
        {
          method,
          agent: this.getAgent(),
          timeout: 15000,
          headers: {
            'Content-Type': 'application/json',
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload).toString() } : {}),
            ...headers,
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            let json: any = {};
            try {
              json = data ? JSON.parse(data) : {};
            } catch {
              /* não-JSON */
            }
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) return resolve(json as T);
            logger.warn({ status, path: url.pathname, err: json?.nome ?? json?.error }, 'Efí API error');
            reject(new HttpError(502, `Efí respondeu ${status}: ${json?.mensagem ?? json?.error_description ?? 'erro'}`));
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('Timeout na API Efí')));
      req.on('error', (e) => reject(new HttpError(502, `Falha de conexão com a Efí: ${e.message}`)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  private async accessToken(): Promise<string> {
    this.getAgent(); // garante agente/token coerentes com a configuração atual
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const cfg = efiConfig();
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
    const data = await this.request<{ access_token: string; expires_in: number }>(
      'POST',
      '/oauth/token',
      { grant_type: 'client_credentials' },
      { Authorization: `Basic ${basic}` },
    );
    this.token = { value: data.access_token, exp: Date.now() + data.expires_in * 1000 };
    return data.access_token;
  }

  private async authed<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const token = await this.accessToken();
    return this.request<T>(method, path, body, { Authorization: `Bearer ${token}`, ...headers });
  }

  static txidFromOrder(orderId: string) {
    return orderId.replace(/-/g, ''); // 32 chars alfanuméricos (regra: 26–35)
  }

  async createCharge(input: CreateChargeInput): Promise<CreatedCharge> {
    const txid = EfiProvider.txidFromOrder(input.orderId);
    const doc = onlyDigits(input.customer.document);
    const devedor = isValidCpf(doc)
      ? { cpf: doc, nome: input.customer.name.slice(0, 200) }
      : isValidCnpj(doc)
        ? { cnpj: doc, nome: input.customer.name.slice(0, 200) }
        : undefined;

    const cob = await this.authed<any>('PUT', `/v2/cob/${txid}`, {
      calendario: { expiracao: input.expiresInSeconds },
      ...(devedor ? { devedor } : {}),
      valor: { original: centsToBRL(input.amountCents) },
      chave: efiConfig().pixKey,
      solicitacaoPagador: input.description.slice(0, 140),
    });

    let pixCode: string | undefined = cob.pixCopiaECola;
    let qrImage: string | null = null;
    if (cob.loc?.id) {
      try {
        const qr = await this.authed<{ qrcode: string; imagemQrcode: string }>('GET', `/v2/loc/${cob.loc.id}/qrcode`);
        pixCode = pixCode ?? qr.qrcode;
        qrImage = qr.imagemQrcode ?? null;
      } catch (e) {
        if (!pixCode) throw e;
      }
    }
    if (!pixCode) throw new HttpError(502, 'Efí não retornou o código PIX');
    return {
      chargeId: txid,
      pixCode,
      qrImage,
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    };
  }

  async getCharge(txid: string): Promise<ChargeInfo> {
    const cob = await this.authed<any>('GET', `/v2/cob/${encodeURIComponent(txid)}`);
    const map: Record<string, ChargeStatus> = {
      ATIVA: 'pending',
      CONCLUIDA: 'paid',
      REMOVIDA_PELO_USUARIO_RECEBEDOR: 'expired',
      REMOVIDA_PELO_PSP: 'expired',
    };
    const paid = Array.isArray(cob.pix) ? cob.pix : [];
    const paidCents = paid.reduce((s: number, p: any) => s + Math.round(Number(p.valor ?? 0) * 100), 0);
    const hasRefund = paid.some((p: any) => Array.isArray(p.devolucoes) && p.devolucoes.some((d: any) => d.status === 'DEVOLVIDO'));
    return {
      chargeId: txid,
      status: hasRefund ? 'refunded' : (map[cob.status] ?? 'unknown'),
      paidAmountCents: paidCents || undefined,
    };
  }

  /**
   * Registra a URL de webhook na Efí. Como Hostinger/proxies não validam o
   * certificado mTLS da Efí, usamos `x-skip-mtls-checking` e protegemos com
   * um segredo na URL (?hmac=) + reconsulta da cobrança na API antes de aprovar.
   */
  async registerWebhook(webhookUrl: string) {
    return this.authed<any>('PUT', `/v2/webhook/${encodeURIComponent(efiConfig().pixKey)}`, { webhookUrl }, {
      'x-skip-mtls-checking': 'true',
    });
  }

  async getWebhook() {
    return this.authed<any>('GET', `/v2/webhook/${encodeURIComponent(efiConfig().pixKey)}`);
  }

  /** Testa Client ID/Secret + certificado obtendo um token OAuth. */
  async testConnection() {
    this.token = null;
    await this.accessToken();
    return true;
  }
}
