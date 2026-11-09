import { Router, type Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { clientIp, HttpError, supabase } from '../lib/core.js';
import { sendMemberCode } from '../services/email.js';
import { getSettings } from '../services/settings.js';
import { createMemberSession, hashCode, memberHome, memberModule, newCode, ownedProductIds, readMemberSession, setLessonDone } from '../services/members.js';

/** Área de membros do aluno: login por código no e-mail ou pelo link do pedido. */
export const membersRouter = Router();

const ipOf = (req: any) => ipKeyGenerator(clientIp(req) ?? req.ip ?? '0.0.0.0');
const rl = (windowMs: number, limit: number, key: (req: any) => string) =>
  rateLimit({ windowMs, limit, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: key, message: { error: 'Muitas tentativas. Aguarde alguns minutos.' } });
const codeLimiter = rl(15 * 60_000, 5, (req) => `${ipOf(req)}|${String(req.body?.email ?? '').trim().toLowerCase()}`);
const verifyLimiter = rl(15 * 60_000, 15, ipOf);
const orderLoginLimiter = rl(10 * 60_000, 30, ipOf);

const emailSchema = z.string().trim().toLowerCase().email().max(200);

function customerOf(req: Request) {
  const h = req.get('authorization') ?? '';
  const id = readMemberSession(h.startsWith('Member ') ? h.slice(7) : null);
  if (!id) throw new HttpError(401, 'Entre novamente na área de membros');
  return id;
}

/** Pede o código de acesso. Responde igual exista ou não o aluno (não revela quem é cliente). */
membersRouter.post('/login/code', codeLimiter, async (req, res) => {
  const email = emailSchema.parse(req.body?.email);
  const { data: c } = await supabase.from('customers').select('id, name').eq('email', email).maybeSingle();
  if (c && (await ownedProductIds((c as any).id)).size) {
    const code = newCode();
    await supabase.from('member_login_codes').insert({ email, code_hash: hashCode(email, code), expires_at: new Date(Date.now() + 15 * 60_000).toISOString() });
    await sendMemberCode(email, (c as any).name ?? '', code);
  }
  res.json({ ok: true });
});

membersRouter.post('/login/verify', verifyLimiter, async (req, res) => {
  const b = z.object({ email: emailSchema, code: z.string().trim().regex(/^\d{6}$/, 'Código de 6 dígitos') }).parse(req.body);
  const { data } = await supabase
    .from('member_login_codes')
    .select('id, code_hash, attempts, expires_at, used_at')
    .eq('email', b.email)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1);
  const row: any = data?.[0];
  if (!row || row.attempts >= 5) throw new HttpError(400, 'Código expirado. Peça um novo.');
  if (row.code_hash !== hashCode(b.email, b.code)) {
    await supabase.from('member_login_codes').update({ attempts: row.attempts + 1 }).eq('id', row.id);
    throw new HttpError(400, 'Código incorreto');
  }
  await supabase.from('member_login_codes').update({ used_at: new Date().toISOString() }).eq('id', row.id);
  const { data: c } = await supabase.from('customers').select('id').eq('email', b.email).maybeSingle();
  if (!c) throw new HttpError(400, 'Código expirado. Peça um novo.');
  res.json({ token: createMemberSession((c as any).id) });
});

/** Entrada direta pelo link do pedido pago (e-mail de entrega, página do Pix, WhatsApp). */
membersRouter.post('/login/order', orderLoginLimiter, async (req, res) => {
  const token = z.string().regex(/^[a-f0-9]{48}$/).parse(req.body?.token);
  const { data } = await supabase.from('orders').select('customer_id, status').eq('public_token', token).maybeSingle();
  const o: any = data;
  if (!o) throw new HttpError(404, 'Pedido não encontrado');
  if (o.status !== 'paid') throw new HttpError(403, 'O acesso é liberado assim que o pagamento é confirmado');
  res.json({ token: createMemberSession(o.customer_id) });
});

membersRouter.get('/me', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const [home, st] = await Promise.all([memberHome(customerOf(req)), getSettings()]);
  // nome e logo exibidos no topo da área (os mesmos da loja / do sistema)
  const name = st.store.name && st.store.name !== 'Minha Loja' ? st.store.name : st.brand.name;
  res.json({ ...home, store: { name, logo_url: st.brand.logoUrl || null } });
});

membersRouter.get('/modules/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await memberModule(customerOf(req), z.string().uuid().parse(req.params.id)));
});

membersRouter.post('/lessons/:id/progress', async (req, res) => {
  const done = z.boolean().parse(req.body?.done);
  await setLessonDone(customerOf(req), z.string().uuid().parse(req.params.id), done);
  res.status(204).end();
});
