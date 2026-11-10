import { mailConfig } from './gateways.js';
import dns from 'node:dns/promises';
import { env } from '../config/env.js';

/**
 * Diagnóstico anti-spam do e-mail: confere no DNS do domínio do remetente os itens que Gmail,
 * Outlook/Hotmail e Yahoo exigem (SPF, DKIM, DMARC, MX) e configurações que derrubam a entrega.
 * Cada item diz o que está errado e o registro exato para corrigir.
 */
export interface Check {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
  fix?: string;
  record?: { type: string; name: string; value: string };
}

const FREE = /@(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|icloud|me|bol|uol|terra|ig)\.(com|com\.br|br)$/i;
// seletores DKIM comuns (Hostinger, Google Workspace, Microsoft 365, Zoho, cPanel/genéricos)
const DKIM_SELECTORS = ['hostingermail1', 'hostingermail2', 'hostingermail-a', 'hostingermail-b', 'hostingermail-c', 'default', 'dkim', 'mail', 'google', 'selector1', 'selector2', 'zoho', 'zmail', 's1', 's2', 'k1', 'smtp'];

const txt = async (name: string) => {
  try {
    return (await dns.resolveTxt(name)).map((r) => r.join(''));
  } catch {
    return [] as string[];
  }
};

export async function emailDeliverability(): Promise<{ domain: string | null; from: string | null; score: number; checks: Check[] }> {
  const mc = mailConfig();
  const from = (mc.from || '').trim().toLowerCase();
  const user = (mc.user || '').trim().toLowerCase();
  const host = (env.SMTP_HOST || '').toLowerCase();
  const checks: Check[] = [];
  const domain = from.includes('@') ? from.split('@')[1] : null;

  if (!mc.configured)
    checks.push({ id: 'smtp', label: 'SMTP configurado', status: 'error', detail: 'SMTP não configurado.', fix: 'Em Integrações → E-mail → Configurar SMTP. Na Hostinger: servidor smtp.hostinger.com, porta 465, e-mail e senha do e-mail do seu domínio.' });
  else checks.push({ id: 'smtp', label: 'SMTP configurado', status: 'ok', detail: `${env.SMTP_HOST}:${env.SMTP_PORT} como ${user}` });

  if (!domain) return { domain, from: from || null, score: 0, checks };

  if (FREE.test(from))
    checks.push({ id: 'free', label: 'Remetente no seu domínio', status: 'error', detail: `${from} é um e-mail gratuito. Gmail/Hotmail/Yahoo marcam como spam e-mails de lojas enviados por endereço gratuito.`, fix: 'Crie um e-mail no seu domínio (ex.: vendas@seudominio.com.br) no Hostinger Email e use como usuário e remetente do SMTP.' });
  else checks.push({ id: 'free', label: 'Remetente no seu domínio', status: 'ok', detail: from });

  if (user && user.includes('@') && user.split('@')[1] !== domain)
    checks.push({ id: 'align', label: 'Remetente igual ao usuário do SMTP', status: 'error', detail: `O e-mail sai como ${from}, mas é autenticado como ${user}. Isso quebra o alinhamento (DMARC) e manda para o spam.`, fix: 'Use o MESMO endereço no usuário do SMTP e no remetente (ou deixe o remetente vazio).' });
  else checks.push({ id: 'align', label: 'Remetente igual ao usuário do SMTP', status: 'ok', detail: 'Alinhado' });

  const [rootTxt, dmarcTxt, mx] = await Promise.all([
    txt(domain),
    txt(`_dmarc.${domain}`),
    dns.resolveMx(domain).catch(() => [] as { exchange: string; priority: number }[]),
  ]);

  // SPF
  const spf = rootTxt.filter((r) => /^v=spf1/i.test(r));
  const wantInclude = /hostinger/.test(host) ? 'include:_spf.mail.hostinger.com' : null;
  if (!spf.length)
    checks.push({ id: 'spf', label: 'SPF (quem pode enviar pelo seu domínio)', status: 'error', detail: 'Nenhum registro SPF encontrado.', fix: 'Adicione no DNS do domínio (hPanel → Domínios → DNS):', record: { type: 'TXT', name: '@', value: `v=spf1 ${wantInclude ?? 'include:SEU_PROVEDOR'} ~all` } });
  else if (spf.length > 1)
    checks.push({ id: 'spf', label: 'SPF (quem pode enviar pelo seu domínio)', status: 'error', detail: `Há ${spf.length} registros SPF. Só pode existir UM; com dois, o SPF falha.`, fix: 'Junte tudo em um único registro TXT, ex.:', record: { type: 'TXT', name: '@', value: `v=spf1 ${wantInclude ?? ''} ~all`.replace(/\s+/g, ' ') } });
  else if (wantInclude && !spf[0].toLowerCase().includes('_spf.mail.hostinger.com'))
    checks.push({ id: 'spf', label: 'SPF (quem pode enviar pelo seu domínio)', status: 'error', detail: `O SPF não autoriza o servidor da Hostinger: ${spf[0]}`, fix: 'Inclua a Hostinger no seu registro SPF existente:', record: { type: 'TXT', name: '@', value: spf[0].replace(/\s*[~?+-]all\s*$/i, '') + ` ${wantInclude} ~all` } });
  else checks.push({ id: 'spf', label: 'SPF (quem pode enviar pelo seu domínio)', status: /-all|~all/i.test(spf[0]) ? 'ok' : 'warn', detail: spf[0], fix: /-all|~all/i.test(spf[0]) ? undefined : 'Termine o SPF com ~all.' });

  // DKIM
  let dkimFound: string | null = null;
  for (const sel of DKIM_SELECTORS) {
    const r = await txt(`${sel}._domainkey.${domain}`);
    if (r.some((v) => /v=DKIM1|p=/i.test(v))) {
      dkimFound = sel;
      break;
    }
  }
  checks.push(
    dkimFound
      ? { id: 'dkim', label: 'DKIM (assinatura do e-mail)', status: 'ok', detail: `Assinatura publicada (seletor “${dkimFound}”).` }
      : { id: 'dkim', label: 'DKIM (assinatura do e-mail)', status: 'error', detail: 'Não encontrei a chave DKIM do domínio. Sem DKIM, Gmail e Yahoo rejeitam ou mandam para o spam.', fix: 'Na Hostinger: hPanel → E-mails → seu domínio → Configurações de DNS / Autenticação → ative o DKIM (os registros CNAME são criados sozinhos se o domínio usa o DNS da Hostinger). Em outro DNS, copie os 3 registros CNAME “hostingermail” mostrados lá.' },
  );

  // DMARC
  const dmarc = dmarcTxt.find((r) => /^v=DMARC1/i.test(r));
  if (!dmarc)
    checks.push({ id: 'dmarc', label: 'DMARC (política do domínio)', status: 'error', detail: 'Nenhum registro DMARC. Desde 2024 Gmail e Yahoo exigem DMARC para quem envia e-mails de loja.', fix: 'Adicione no DNS:', record: { type: 'TXT', name: '_dmarc', value: `v=DMARC1; p=none; rua=mailto:${from}; adkim=r; aspf=r` } });
  else checks.push({ id: 'dmarc', label: 'DMARC (política do domínio)', status: 'ok', detail: dmarc });

  // MX
  checks.push(
    mx.length
      ? { id: 'mx', label: 'Caixa de entrada do domínio (MX)', status: 'ok', detail: mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange).slice(0, 2).join(', ') }
      : { id: 'mx', label: 'Caixa de entrada do domínio (MX)', status: 'warn', detail: 'O domínio não recebe e-mails (sem MX). Provedores desconfiam de remetentes que não podem receber respostas.', fix: 'Ative o e-mail do domínio na Hostinger (hPanel → E-mails) para criar os registros MX.' },
  );

  const weight = { ok: 1, warn: 0.5, error: 0 } as const;
  const score = Math.round((checks.reduce((s, c) => s + weight[c.status], 0) / checks.length) * 10);
  return { domain, from, score, checks };
}
