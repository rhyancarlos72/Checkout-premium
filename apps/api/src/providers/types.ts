export type ProviderName = 'woovi' | 'efi';

export interface CreateChargeInput {
  /** ID interno do pedido (UUID) — usado como correlationID/txid para idempotência */
  orderId: string;
  amountCents: number;
  description: string;
  expiresInSeconds: number;
  customer: {
    name: string;
    email: string;
    phone?: string | null;
    document?: string | null; // CPF ou CNPJ (só dígitos)
  };
  /** 'card' = cartão de crédito (página segura do gateway); padrão Pix */
  method?: 'pix' | 'card';
  /** máximo de parcelas oferecidas no cartão (sem juros para o cliente) */
  cardInstallments?: number;
  /** venda de produtor: parte dele vai direto para o recebedor; a comissão fica com a Prime */
  split?: SplitSpec | null;
}

export interface SplitSpec {
  producerCents: number;
  platformCents: number;
  recipient: { pixKey?: string; account?: string; document?: string; name?: string };
}

export interface CreatedCharge {
  chargeId: string;
  pixCode: string; // copia e cola (BR Code)
  qrImage: string | null; // URL ou data URI da imagem
  expiresAt: Date;
  /** cartão: página segura do gateway para o cliente digitar o cartão */
  cardUrl?: string | null;
  /** o que foi enviado ao gateway para dividir a venda */
  splitInfo?: Record<string, unknown> | null;
}

export type ChargeStatus = 'pending' | 'paid' | 'expired' | 'refunded' | 'unknown';

export interface ChargeInfo {
  chargeId: string;
  status: ChargeStatus;
  paidAmountCents?: number;
}

/**
 * Contrato comum a todos os gateways PIX. Para adicionar um novo provedor,
 * implemente esta interface e registre em providers/index.ts.
 */
export interface PixProvider {
  readonly name: ProviderName;
  isConfigured(): boolean;
  createCharge(input: CreateChargeInput): Promise<CreatedCharge>;
  getCharge(chargeId: string): Promise<ChargeInfo>;
}
