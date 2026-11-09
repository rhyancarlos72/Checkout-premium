import type { Request } from 'express';
import { clientIp, logger, supabase } from '../lib/core.js';

const SECRET = /key|secret|token|pass|cert|pfx|senha|hmac|appid|authorization/i;

/** Remove valores sensíveis (chaves, tokens, certificados) antes de gravar na auditoria. */
export function redact(v: unknown, depth = 0): unknown {
  if (depth > 4 || v == null) return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = SECRET.test(k) ? (val ? '••••' : val) : redact(val, depth + 1);
    return out;
  }
  return typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}…` : v;
}

/** Registro de ações administrativas (quem, o quê, quando, de onde). Nunca derruba a requisição. */
export async function audit(req: Request, action: string, target?: string | null, data?: unknown) {
  try {
    await supabase.from('audit_logs').insert({
      actor_id: req.adminId ?? null,
      actor_email: req.adminEmail ?? null,
      org_id: req.orgId ?? null,
      action,
      target: target ?? null,
      data: redact(data ?? {}) as object,
      ip: clientIp(req as any),
    });
  } catch (e) {
    logger.warn({ err: (e as Error)?.message, action }, 'Auditoria: falha ao registrar');
  }
}
