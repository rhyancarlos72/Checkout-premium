import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { env } from '../config/env.js';
import { logger, supabase } from '../lib/core.js';
import { findOrderByCharge, syncOrderWithProvider } from '../services/orders.js';

export const webhookRouter = Router();

function safeEqual(a: string | undefined, b: string | undefined) {
  if (!a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

async function log(provider: string, reference: string | null, payload: unknown, status: string, error?: string) {
  await supabase.from('webhook_logs').insert({ provider, reference, payload: payload as any, status, error: error ?? null });
}

/**
 * Woovi: configure no painel Woovi → Webhooks
 *   URL: {PUBLIC_URL}/api/webhooks/woovi   Evento: OPENPIX:CHARGE_COMPLETED
 *   Authorization (opcional): mesmo valor de WOOVI_WEBHOOK_SECRET
 * O status é SEMPRE reconsultado na API da Woovi antes de aprovar.
 */
webhookRouter.post('/woovi', async (req: Request, res) => {
  const body: any = req.body ?? {};
  if (env.WOOVI_WEBHOOK_SECRET) {
    const provided = (req.get('authorization') ?? req.get('x-webhook-secret') ?? String(req.query.secret ?? '')).replace(/^Bearer\s+/i, '');
    if (!safeEqual(provided, env.WOOVI_WEBHOOK_SECRET)) {
      await log('woovi', null, { event: body?.event }, 'error', 'segredo inválido');
      return res.status(401).json({ error: 'unauthorized' });
    }
  }
  // Teste de configuração do painel Woovi
  if (body?.evento === 'teste_webhook' || body?.event === 'teste_webhook') return res.json({ ok: true });

  const correlationID: string | undefined = body?.charge?.correlationID ?? body?.pix?.charge?.correlationID;
  res.json({ ok: true }); // responde rápido; processamento segue
  if (!correlationID) return log('woovi', null, { event: body?.event }, 'ignored', 'sem correlationID');
  try {
    const orderId = await findOrderByCharge('woovi', correlationID);
    if (!orderId) return log('woovi', correlationID, { event: body?.event }, 'ignored', 'pedido não encontrado');
    const result = await syncOrderWithProvider(orderId);
    await log('woovi', correlationID, { event: body?.event, status: body?.charge?.status }, 'processed', result);
  } catch (e: any) {
    logger.error({ err: e?.message, correlationID }, 'Webhook Woovi falhou');
    await log('woovi', correlationID, { event: body?.event }, 'error', String(e?.message ?? e));
  }
});

/**
 * Efí: a URL é registrada pelo painel (Integrações → Efí → Registrar webhook)
 *   {PUBLIC_URL}/api/webhooks/efi?hmac=EFI_WEBHOOK_SECRET  (a Efí acrescenta /pix)
 */
async function efiHandler(req: Request, res: any) {
  if (env.EFI_WEBHOOK_SECRET && !safeEqual(String(req.query.hmac ?? ''), env.EFI_WEBHOOK_SECRET)) {
    await log('efi', null, null, 'error', 'hmac inválido');
    return res.status(401).json({ error: 'unauthorized' });
  }
  const pixList: any[] = Array.isArray(req.body?.pix) ? req.body.pix : [];
  res.status(200).json({ ok: true });
  for (const pix of pixList) {
    const txid: string | undefined = pix?.txid;
    if (!txid) continue;
    try {
      const orderId = await findOrderByCharge('efi', txid);
      if (!orderId) {
        await log('efi', txid, { endToEndId: pix.endToEndId }, 'ignored', 'pedido não encontrado');
        continue;
      }
      const result = await syncOrderWithProvider(orderId);
      await log('efi', txid, { endToEndId: pix.endToEndId, valor: pix.valor }, 'processed', result);
    } catch (e: any) {
      logger.error({ err: e?.message, txid }, 'Webhook Efí falhou');
      await log('efi', txid, null, 'error', String(e?.message ?? e));
    }
  }
}
webhookRouter.post('/efi', efiHandler);
webhookRouter.post('/efi/pix', efiHandler);
