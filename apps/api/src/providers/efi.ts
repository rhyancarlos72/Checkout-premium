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

  /** Pré-aquece conexão mTLS + token, para o primeiro Pix sair sem espera. */
  async warm() {
    if (!this.isConfigured()) return;
    if (this.token && this.token.exp < Date.now() + 10 * 60_000) this.token = null; // renova antes de vencer
    await this.accessToken();
  }

  static txidFromOrder(orderId: string) {
    return orderId.replace(/-/g, ''); // 32 chars alfanuméricos (regra: 26–35)
  }

  /**
   * Split Pix Efí (dev.efipay.com.br/docs/api-pix/split-de-pagamento-pix): só entre contas Efí.
   * Valores FIXOS: comissão da Prime ("minhaParte") + parte do produtor ("repasses") = valor da cobrança.
   */
  private async createSplitConfig(input: CreateChargeInput) {
    const sp = input.split!;
    const doc = onlyDigits(sp.recipient.document);
    if (!sp.recipient.account || (doc.length !== 11 && doc.length !== 14)) throw new HttpError(400, 'Recebedor Efí do produtor incompleto (conta e CPF/CNPJ)');
    if (sp.producerCents <= 0 || sp.producerCents + sp.platformCents !== input.amountCents) throw new HttpError(400, 'Valores do split não fecham com o total da cobrança');
    const body = {
      descricao: input.description.slice(0, 80),
      lancamento: { imediato: true },
      split: {
        divisaoTarifa: 'assumir_total',
        minhaParte: { tipo: 'fixo', valor: centsToBRL(sp.platformCents) },
        repasses: [{ tipo: 'fixo', valor: centsToBRL(sp.producerCents), favorecido: { [doc.length === 14 ? 'cnpj' : 'cpf']: doc, conta: sp.recipient.account } }],
      },
    };
    const cfg = await this.authed<any>('POST', '/v2/gn/split/config', body);
    if (!cfg?.id) throw new HttpError(502, 'A Efí não criou a configuração de split');
    return { id: String(cfg.id), body };
  }

  async createCharge(input: CreateChargeInput): Promise<CreatedCharge> {
    if (input.method === 'card') throw new HttpError(400, 'Cartão pela Efí ainda não está disponível. Use a Woovi para cartão.');
    const txid = EfiProvider.txidFromOrder(input.orderId);
    const split = input.split ? await this.createSplitConfig(input) : null;
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

    if (split) {
      try {
        await this.authed('PUT', `/v2/gn/split/cob/${txid}/vinculo/${split.id}`);
      } catch (e: any) {
        // sem o vínculo o dinheiro do produtor cairia todo na conta da Prime: cancela a cobrança e não mostra o Pix
        await this.authed('PATCH', `/v2/cob/${txid}`, { status: 'REMOVIDA_PELO_USUARIO_RECEBEDOR' }).catch(() => {});
        throw new HttpError(502, `A Efí recusou o split desta venda: ${e?.message ?? 'erro'}`);
      }
    }

    let pixCode: string | undefined = cob.pixCopiaECola;
    let qrImage: string | null = null;
    // a cobrança já traz o copia e cola: o QR é gerado localmente (economiza uma chamada à Efí)
    if (!pixCode && cob.loc?.id) {
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
      splitInfo: split ? { gateway: 'efi', splitConfigId: split.id, config: split.body } : null,
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

  // ------------------------------------------------------------------ Pix Automático (dev.efipay.com.br/docs/api-pix/pix-automatico)
  /**
   * Jornada 3: UM QR Code que paga o pedido agora (cobrança imediata) E autoriza a mensalidade no app do banco.
   * Passos da Efí: location de recorrência → cobrança imediata → recorrência (com o location e o txid) →
   * consulta da recorrência com o txid para obter o copia e cola único.
   * Se qualquer passo da recorrência falhar (ex.: Pix Automático não liberado na conta), devolve o Pix
   * normal da cobrança já criada: a venda nunca trava; a mensalidade passa a ser cobrada por Pix de renovação.
   */
  async createAutoCharge(input: CreateChargeInput & { rec: { cpf: string; name: string; monthlyCents: number; contract: string; object: string; firstDue: string } }): Promise<CreatedCharge & { recId: string | null; recError?: string }> {
    const cpf = onlyDigits(input.rec.cpf);
    if (!isValidCpf(cpf) && !isValidCnpj(cpf)) throw new HttpError(400, 'Informe um CPF válido para a assinatura');
    const charge = await this.createCharge({ ...input, split: null, customer: { ...input.customer, document: cpf } });
    const txid = charge.chargeId;
    try {
      const loc = await this.authed<{ id: number }>('POST', '/v2/locrec');
      if (!loc?.id) throw new Error('location de recorrência não criado');
      const devedor = cpf.length === 14 ? { cnpj: cpf, nome: input.rec.name.slice(0, 140) } : { cpf, nome: input.rec.name.slice(0, 140) };
      const rec = await this.authed<{ idRec: string }>('POST', '/v2/rec', {
        vinculo: { contrato: input.rec.contract.slice(0, 35), devedor, objeto: input.rec.object.slice(0, 35) },
        calendario: { dataInicial: input.rec.firstDue, periodicidade: 'MENSAL' },
        valor: { valorRec: centsToBRL(input.rec.monthlyCents) },
        // até 3 novas tentativas em 7 dias se o débito do mês não passar (cobre os 3 dias de tolerância)
        politicaRetentativa: 'PERMITE_3R_7D',
        loc: loc.id,
        ativacao: { dadosJornada: { txid } },
      });
      if (!rec?.idRec) throw new Error('recorrência não criada');
      const full = await this.authed<any>('GET', `/v2/rec/${encodeURIComponent(rec.idRec)}?txid=${encodeURIComponent(txid)}`);
      const code = full?.dadosQR?.pixCopiaECola as string | undefined;
      if (!code) throw new Error('a Efí não devolveu o copia e cola do Pix Automático');
      return { ...charge, pixCode: code, qrImage: null, recId: rec.idRec };
    } catch (e: any) {
      logger.warn({ err: e?.message, txid }, 'Pix Automático indisponível: segue com o Pix normal (renovação por lembrete)');
      return { ...charge, recId: null, recError: String(e?.message ?? e).slice(0, 300) };
    }
  }

  /** Recorrência (autorização do cliente): CRIADA, APROVADA, REJEITADA, EXPIRADA ou CANCELADA. */
  async getRec(idRec: string) {
    return this.authed<{ idRec: string; status: string; valor?: { valorRec?: string } }>('GET', `/v2/rec/${encodeURIComponent(idRec)}`);
  }
  async cancelRec(idRec: string) {
    return this.authed<any>('PATCH', `/v2/rec/${encodeURIComponent(idRec)}`, { status: 'CANCELADA' });
  }

  /** Cobrança do mês na recorrência aprovada: deve ser enviada de 2 a 10 dias antes do vencimento (regra do Pix Automático). */
  async createCobr(input: { txid: string; idRec: string; dueDate: string; amountCents: number; info: string; account?: string | null }) {
    return this.authed<{ txid: string; status: string }>('PUT', `/v2/cobr/${encodeURIComponent(input.txid)}`, {
      idRec: input.idRec,
      infoAdicional: input.info.slice(0, 140),
      calendario: { dataDeVencimento: input.dueDate },
      valor: { original: centsToBRL(input.amountCents) },
      ajusteDiaUtil: true,
      ...(input.account ? { recebedor: { agencia: '0001', conta: onlyDigits(input.account), tipoConta: 'PAGAMENTO' } } : {}),
    });
  }
  /** Cobrança do mês: CRIADA, ATIVA, CONCLUIDA (paga), EXPIRADA, REJEITADA ou CANCELADA. */
  async getCobr(txid: string) {
    return this.authed<{ txid: string; idRec: string; status: string; valor?: { original?: string } }>('GET', `/v2/cobr/${encodeURIComponent(txid)}`);
  }

  /** Avisos do Pix Automático (autorizações e mensalidades) — mesma proteção do webhook Pix (segredo na URL + reconsulta). */
  async registerAutoWebhooks(recUrl: string, cobrUrl: string) {
    const h = { 'x-skip-mtls-checking': 'true' };
    await this.authed<any>('PUT', '/v2/webhookrec', { webhookUrl: recUrl }, h);
    await this.authed<any>('PUT', '/v2/webhookcobr', { webhookUrl: cobrUrl }, h);
  }

  /** Testa Client ID/Secret + certificado obtendo um token OAuth. */
  async testConnection() {
    this.token = null;
    await this.accessToken();
    return true;
  }
}
