import { Router } from 'express';
import { z } from 'zod';
import { HttpError, must, supabase } from '../lib/core.js';
import { clearOrgCache, ownerOrgId } from '../lib/tenant.js';
import { clearAuthCache } from '../middleware/auth.js';
import { audit } from '../services/audit.js';

/**
 * Super Admin (dono da plataforma): produtores, taxas, financeiro global e auditoria.
 * Montado em /api/admin/platform — o /admin já exige o Super Admin para este caminho.
 * Usa o cliente SEM filtro de organização (visão de toda a plataforma).
 */
export const platformRouter = Router();
const uuid = z.string().uuid();

platformRouter.use(async (_req, _res, next) => {
  if (!(await ownerOrgId())) return next(new HttpError(503, 'Rode no Supabase o SQL do marketplace (20261112000000_marketplace_base.sql) para ativar a gestão de produtores.'));
  next();
});

// ---------------------------------------------------------------- produtores
platformRouter.get('/producers', async (_req, res) => {
  const [{ data: orgs }, { data: members }, { data: ledger }, { data: products }] = await Promise.all([
    supabase.from('organizations').select('*').order('created_at', { ascending: true }),
    supabase.from('org_members').select('org_id, email, role'),
    supabase.from('ledger_entries').select('org_id, type, amount_cents'),
    supabase.from('products').select('org_id'),
  ]);
  const sum = (org: string, type: string) => ((ledger ?? []) as any[]).filter((l) => l.org_id === org && l.type === type).reduce((s, l) => s + l.amount_cents, 0);
  res.json(
    ((orgs ?? []) as any[]).map((o) => ({
      id: o.id,
      name: o.name,
      legal_name: o.legal_name,
      document: o.document,
      phone: o.phone,
      status: o.status,
      owner: o.is_platform_owner,
      pix_provider: o.pix_provider,
      split_enabled: o.split_enabled,
      recipient: o.recipient ?? {},
      created_at: o.created_at,
      emails: ((members ?? []) as any[]).filter((m) => m.org_id === o.id).map((m) => m.email).filter(Boolean),
      products: ((products ?? []) as any[]).filter((p) => p.org_id === o.id).length,
      gross_cents: sum(o.id, 'sale'),
      fees_cents: -sum(o.id, 'platform_fee') - sum(o.id, 'fee_reversal'),
      refunds_cents: -sum(o.id, 'refund') - sum(o.id, 'chargeback'),
    })),
  );
});

const producerPatch = z.object({
  status: z.enum(['active', 'suspended']).optional(),
  pix_provider: z.enum(['woovi', 'efi']).nullable().optional(),
  split_enabled: z.boolean().optional(),
  // identificação do recebedor no gateway (conta Efí / chave Pix / subconta Woovi), validada na fase do split
  recipient: z.object({ account: z.string().trim().max(60).optional(), document: z.string().trim().max(20).optional(), pix_key: z.string().trim().max(120).optional(), name: z.string().trim().max(120).optional() }).optional(),
  name: z.string().trim().min(2).max(120).optional(),
});
platformRouter.put('/producers/:id', async (req, res) => {
  const id = uuid.parse(req.params.id);
  const b = producerPatch.parse(req.body);
  const { data: cur } = await supabase.from('organizations').select('id, is_platform_owner').eq('id', id).maybeSingle();
  if (!cur) throw new HttpError(404, 'Produtor não encontrado');
  // a organização proprietária não pode ser suspensa nem ter o recebimento trocado por aqui
  if ((cur as any).is_platform_owner && (b.status === 'suspended' || b.split_enabled === false)) throw new HttpError(400, 'A conta proprietária da plataforma não pode ser suspensa');
  if (b.split_enabled && !(cur as any).is_platform_owner) {
    const rec = b.recipient ?? ((await supabase.from('organizations').select('recipient, pix_provider').eq('id', id).maybeSingle()).data as any)?.recipient;
    const provider = b.pix_provider ?? ((await supabase.from('organizations').select('pix_provider').eq('id', id).maybeSingle()).data as any)?.pix_provider;
    // Woovi: split vai para a CHAVE PIX do produtor; Efí: split só entre contas Efí (nº da conta + CPF/CNPJ do titular)
    if (!provider) throw new HttpError(400, 'Defina o gateway do produtor antes de liberar as vendas');
    if (provider === 'woovi' && !rec?.pix_key) throw new HttpError(400, 'Woovi: informe a chave Pix do produtor para o split');
    const doc = String(rec?.document ?? '').replace(/\D/g, '');
    if (provider === 'efi' && (!rec?.account || (doc.length !== 11 && doc.length !== 14))) throw new HttpError(400, 'Efí: informe o número da conta Efí e o CPF/CNPJ do titular para o split');
  }
  const row = must(await supabase.from('organizations').update({ ...b, updated_at: new Date().toISOString() }).eq('id', id).select('*').single());
  clearOrgCache();
  clearAuthCache(); // suspensão vale na hora
  await audit(req, 'producer.update', id, b);
  res.json(row);
});

// ---------------------------------------------------------------- taxas (versionadas: cada alteração é uma nova linha)
platformRouter.get('/fees', async (_req, res) => {
  const { data } = await supabase.from('fee_policies').select('*, org:organizations(name)').order('created_at', { ascending: false }).limit(200);
  res.json(data ?? []);
});
const feeSchema = z.object({
  org_id: uuid.nullable().default(null), // null = regra geral
  fixed_cents: z.number().int().min(0).max(100_000),
  percent_bps: z.number().int().min(0).max(5_000), // até 50%
  bump_cents: z.number().int().min(0).max(100_000),
  gateway_fee_payer: z.enum(['producer', 'platform']).default('producer'),
  refund_policy: z.enum(['keep_fee', 'refund_fee']).default('keep_fee'),
  note: z.string().trim().max(200).optional().nullable(),
});
platformRouter.post('/fees', async (req, res) => {
  const b = feeSchema.parse(req.body);
  if (b.org_id && b.org_id === (await ownerOrgId())) throw new HttpError(400, 'A conta proprietária é isenta: não recebe tabela de taxas');
  const row = must(await supabase.from('fee_policies').insert({ ...b, created_by: req.adminId }).select('*').single());
  await audit(req, 'fees.create', b.org_id ?? 'geral', b);
  res.status(201).json(row);
});

// ---------------------------------------------------------------- financeiro global
platformRouter.get('/finance', async (req, res) => {
  const q = z.object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() }).parse(req.query);
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86400_000);
  const [{ data: ledger }, { data: orgs }] = await Promise.all([
    supabase.from('ledger_entries').select('org_id, type, amount_cents, data, created_at').gte('created_at', from.toISOString()).lt('created_at', to.toISOString()).limit(100_000),
    supabase.from('organizations').select('id, name, is_platform_owner'),
  ]);
  const rows = (ledger ?? []) as any[];
  const total = (type: string) => rows.filter((l) => l.type === type).reduce((s, l) => s + l.amount_cents, 0);
  const byOrg = ((orgs ?? []) as any[]).map((o) => {
    const mine = rows.filter((l) => l.org_id === o.id);
    const t = (type: string) => mine.filter((l) => l.type === type).reduce((s, l) => s + l.amount_cents, 0);
    return { org_id: o.id, name: o.name, owner: o.is_platform_owner, gross_cents: t('sale'), fees_cents: -t('platform_fee') - t('fee_reversal'), refunds_cents: -t('refund') - t('chargeback'), sales: mine.filter((l) => l.type === 'sale').length };
  });
  const byGateway = ['woovi', 'efi'].map((g) => ({ gateway: g, gross_cents: rows.filter((l) => l.type === 'sale' && l.data?.provider === g).reduce((s, l) => s + l.amount_cents, 0) }));
  res.json({
    period: { from, to },
    gross_cents: total('sale'),
    platform_fees_cents: -total('platform_fee') - total('fee_reversal'),
    refunds_cents: -total('refund'),
    chargebacks_cents: -total('chargeback'),
    sales: rows.filter((l) => l.type === 'sale').length,
    by_org: byOrg.sort((a, b) => b.gross_cents - a.gross_cents),
    by_gateway: byGateway,
  });
});

// ---------------------------------------------------------------- auditoria
platformRouter.get('/audit', async (_req, res) => {
  const { data } = await supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(200);
  res.json(data ?? []);
});
