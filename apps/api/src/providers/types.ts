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
}

export interface CreatedCharge {
  chargeId: string;
  pixCode: string; // copia e cola (BR Code)
  qrImage: string | null; // URL ou data URI da imagem
  expiresAt: Date;
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
