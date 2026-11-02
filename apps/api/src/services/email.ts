import crypto from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import { env, features } from '../config/env.js';
import { escapeHtml, formatBRL, logger, supabase } from '../lib/core.js';
import { getSettings } from './settings.js';

let transporter: Transporter | null = null;
function getTransporter() {
  if (!features.email) return null;
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  return transporter;
}

function layout(title: string, inner: string, accent = '#0f766e') {
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1f2937">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 12px">
  <table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb">
  <tr><td style="background:${accent};height:6px"></td></tr>
  <tr><td style="padding:32px 28px">
    <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3">${escapeHtml(title)}</h1>
    ${inner}
  </td></tr>
  <tr><td style="padding:16px 28px;background:#f9fafb;color:#6b7280;font-size:12px">Você recebeu este e-mail porque fez um pedido em ${escapeHtml(new URL(env.PUBLIC_URL).host)}.</td></tr>
  </table></td></tr></table></body></html>`;
}

const button = (href: string, label: string, color = '#16a34a') =>
  `<a href="${escapeHtml(href)}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px;font-size:15px">${escapeHtml(label)}</a>`;

type SendExtras = { text?: string; replyTo?: string; fromName?: string; headers?: Record<string, string> };

async function send(to: string, subject: string, html: string, orderId: string, event: string, extras: SendExtras = {}) {
  const t = getTransporter();
  if (!t) {
    await supabase.from('integration_logs').insert({ integration: 'email', order_id: orderId, event, ok: false, message: 'SMTP não configurado' });
    return false;
  }
  try {
    await t.sendMail({
      from: { name: extras.fromName || env.MAIL_FROM_NAME, address: env.MAIL_FROM ?? env.SMTP_USER! },
      to,
      subject,
      html,
      // versão em texto puro: e-mail só com HTML pontua mal nos filtros de spam
      text: extras.text ?? htmlToText(html),
      ...(extras.replyTo ? { replyTo: extras.replyTo } : {}),
      ...(extras.headers ? { headers: extras.headers } : {}),
    });
    await supabase.from('integration_logs').insert({ integration: 'email', order_id: orderId, event, ok: true, message: 'enviado' });
    return true;
  } catch (e: any) {
    logger.error({ err: e?.message, orderId }, 'Falha ao enviar e-mail');
    await supabase.from('integration_logs').insert({ integration: 'email', order_id: orderId, event, ok: false, message: String(e?.message ?? e).slice(0, 300) });
    return false;
  }
}

function htmlToText(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<(br|\/p|\/div|\/h1|\/tr|\/li)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

// ------------------------------------------------------------------ descadastro (exigido por Gmail/Yahoo para e-mails em volume)
export const unsubscribeSig = (email: string) => crypto.createHmac('sha256', env.SUPABASE_SERVICE_ROLE_KEY).update(`unsub:${email.toLowerCase()}`).digest('hex').slice(0, 32);
export const unsubscribeUrl = (email: string) => `${env.PUBLIC_URL}/api/public/unsubscribe?e=${encodeURIComponent(email.toLowerCase())}&s=${unsubscribeSig(email)}`;
export async function isUnsubscribed(email: string) {
  const { count } = await supabase.from('events').select('id', { count: 'exact', head: true }).eq('type', 'email_unsubscribe').eq('session_id', email.toLowerCase());
  return (count ?? 0) > 0;
}
export async function unsubscribe(email: string) {
  if (await isUnsubscribed(email)) return;
  await supabase.from('events').insert({ type: 'email_unsubscribe', session_id: email.toLowerCase(), data: {} });
}

export interface DeliveryItem {
  name: string;
  url: string | null;
  note: string | null;
  image?: string | null;
  kind?: string;
}

export interface DeliveryEmailInput {
  orderId: string;
  orderCode: string; // ID de 7 dígitos (o mesmo do painel)
  to: string;
  name: string;
  items: DeliveryItem[];
  accessUrl: string;
  totalCents?: number;
  accent?: string;
}

const prettyHost = (url: string) => {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    if (/drive\.google|docs\.google/.test(h)) return 'Google Drive';
    if (/supabase\.co$/.test(h)) return 'download seguro';
    return h;
  } catch {
    return '';
  }
};

/**
 * Entrega após o pagamento aprovado: nome do cliente, link de acesso (Drive/arquivo) de cada
 * produto em destaque, link em texto (caso o botão não abra), resumo do pedido e suporte.
 */
export async function sendDeliveryEmail(p: DeliveryEmailInput) {
  const { store } = await getSettings();
  const storeName = store.name && store.name !== 'Minha Loja' ? store.name : env.MAIL_FROM_NAME;
  const firstRaw = (p.name.trim().split(/\s+/)[0] ?? '').replace(/^./, (c) => c.toUpperCase());
  const first = escapeHtml(firstRaw);
  const accent = /^#[0-9a-f]{6}$/i.test(p.accent ?? '') ? p.accent! : '#16a34a';
  const main = p.items[0];
  const mainName = main?.name ?? 'seu produto';
  const preheader = `Pagamento confirmado! Seu acesso a ${mainName} está aqui. Guarde este e-mail.`;

  const cards = p.items
    .map((i, idx) => {
      const name = escapeHtml(i.name);
      const host = i.url ? prettyHost(i.url) : '';
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:14px;margin:0 0 14px">
        <tr><td style="padding:16px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            ${i.image ? `<td width="68" valign="top"><img src="${escapeHtml(i.image)}" width="56" height="56" alt="" style="display:block;width:56px;height:56px;border-radius:10px;object-fit:cover;border:1px solid #e5e7eb"></td>` : ''}
            <td valign="top">
              <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${accent}">${idx === 0 ? 'Seu produto' : 'Adicional'}</p>
              <p style="margin:3px 0 0;font-size:16px;font-weight:700;color:#111827">${name}</p>
              ${i.note ? `<p style="margin:6px 0 0;font-size:14px;line-height:1.5;color:#4b5563">${escapeHtml(i.note)}</p>` : ''}
            </td>
          </tr></table>
          ${
            i.url
              ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:14px"><tr><td bgcolor="${accent}" style="border-radius:10px">
                  <a href="${escapeHtml(i.url)}" target="_blank" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px">Acessar ${idx === 0 ? 'meu produto' : 'agora'}</a>
                </td></tr></table>
                <p style="margin:10px 0 0;font-size:12px;line-height:1.5;color:#6b7280">${host ? `Abre no ${escapeHtml(host)}. ` : ''}Se o botão não abrir, copie o link:<br><a href="${escapeHtml(i.url)}" style="color:${accent};word-break:break-all">${escapeHtml(i.url)}</a></p>`
              : '<p style="margin:12px 0 0;font-size:14px;color:#6b7280">O acesso a este item será enviado em breve neste e-mail.</p>'
          }
        </td></tr>
      </table>`;
    })
    .join('');

  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Acesso liberado</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}${'&nbsp;&zwnj;'.repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;border:1px solid #e5e7eb">
  <tr><td style="padding:28px 28px 6px">
    <p style="margin:0 0 14px;font-size:13px;color:#6b7280">${escapeHtml(storeName)}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 14px"><tr><td style="background:${accent}1a;border-radius:999px;padding:6px 12px;font-size:13px;font-weight:700;color:${accent}">&#10003;&nbsp; Pagamento aprovado</td></tr></table>
    <h1 style="margin:0 0 10px;font-size:23px;line-height:1.3;color:#111827">${first ? `${first}, seu` : 'Seu'} acesso está liberado</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#374151">Obrigado pela compra! Seu Pix foi confirmado e abaixo está tudo o que você adquiriu. Clique no botão para acessar.</p>
  </td></tr>
  <tr><td style="padding:0 28px">${cards}</td></tr>
  <tr><td style="padding:6px 28px 4px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:12px"><tr><td style="padding:14px 16px;font-size:14px;line-height:1.7;color:#374151">
      <b style="color:#111827">Dicas para não perder seu acesso</b><br>
      &#8226; Guarde este e-mail ou marque com estrela.<br>
      &#8226; No Google Drive, entre com sua conta Google para baixar ou salvar uma cópia.<br>
      &#8226; Você também pode reabrir seus acessos <a href="${escapeHtml(p.accessUrl)}" style="color:${accent}">nesta página</a>.
    </td></tr></table>
  </td></tr>
  <tr><td style="padding:18px 28px 26px">
    <p style="margin:0;font-size:13px;line-height:1.7;color:#6b7280">Pedido <b style="color:#374151">ID: ${escapeHtml(p.orderCode)}</b>${p.totalCents ? ` · ${formatBRL(p.totalCents)} no Pix` : ''}</p>
    <p style="margin:10px 0 0;font-size:14px;line-height:1.6;color:#374151">Alguma dúvida ou dificuldade para acessar? É só responder este e-mail que a gente ajuda.</p>
  </td></tr>
</table>
<p style="max-width:560px;margin:16px auto 0;font-size:11px;line-height:1.6;color:#9ca3af;text-align:center">
  ${escapeHtml(storeName)}${store.document ? ` · ${escapeHtml(store.document)}` : ''}<br>
  Você recebeu este e-mail porque fez uma compra em ${escapeHtml(new URL(env.PUBLIC_URL).host)}.
</p>
</td></tr></table></body></html>`;

  const text = [
    `${firstRaw ? `${firstRaw}, seu` : 'Seu'} acesso está liberado`,
    '',
    'Pagamento aprovado! Obrigado pela compra. Seus acessos:',
    '',
    ...p.items.flatMap((i) => [`> ${i.name}`, ...(i.note ? [i.note] : []), i.url ? `Acessar: ${i.url}` : 'O acesso será enviado em breve.', '']),
    `Seus acessos também ficam nesta página: ${p.accessUrl}`,
    '',
    `Pedido ID: ${p.orderCode}${p.totalCents ? ` · ${formatBRL(p.totalCents)} no Pix` : ''}`,
    'Dúvidas? É só responder este e-mail.',
    '',
    '--',
    storeName,
  ].join('\n');

  return send(p.to, `${firstRaw ? `${firstRaw}, seu` : 'Seu'} acesso a ${mainName} chegou`, html, p.orderId, 'delivery', {
    text,
    fromName: storeName,
    replyTo: store.supportEmail || undefined,
    headers: { 'X-Entity-Ref-ID': p.orderId },
  });
}

export interface RecoveryEmailInput {
  orderId: string;
  to: string;
  name: string;
  productName: string;
  productImage?: string | null;
  extras?: string[]; // order bumps incluídos
  totalCents: number;
  url: string;
  accent?: string;
  guaranteeDays?: number;
}

/**
 * Recuperação de Pix pendente.
 * Persuasão honesta (sem CAPS, sem "URGENTE", sem prazo falso) + boas práticas de entrega:
 * assunto pessoal, pré-cabeçalho, versão texto, Reply-To de suporte, List-Unsubscribe (1 clique),
 * pouco HTML/imagem e um único link principal.
 */
export async function sendRecoveryEmail(p: RecoveryEmailInput) {
  if (await isUnsubscribed(p.to)) {
    await supabase.from('integration_logs').insert({ integration: 'email', order_id: p.orderId, event: 'recovery', ok: false, message: 'cliente pediu para não receber e-mails' });
    return false;
  }
  const { store } = await getSettings();
  const storeName = store.name && store.name !== 'Minha Loja' ? store.name : env.MAIL_FROM_NAME;
  const firstRaw = (p.name.trim().split(/\s+/)[0] ?? '').replace(/^./, (c) => c.toUpperCase());
  const first = escapeHtml(firstRaw);
  const product = escapeHtml(p.productName);
  const accent = /^#[0-9a-f]{6}$/i.test(p.accent ?? '') ? p.accent! : '#16a34a';
  const price = formatBRL(p.totalCents);
  const unsub = unsubscribeUrl(p.to);
  const guarantee = p.guaranteeDays && p.guaranteeDays > 0 ? p.guaranteeDays : null;
  const preheader = `Seu pedido de ${p.productName} está guardado. Pelo Pix, leva menos de 1 minuto para concluir.`;

  const benefits = [
    ['Acesso na hora', 'assim que o Pix é confirmado, o acesso chega neste e-mail.'],
    ['Pagamento seguro', 'Pix processado por instituição autorizada pelo Banco Central.'],
    ...(guarantee ? [[`Garantia de ${guarantee} dias`, 'se não gostar, devolvemos 100% do valor.']] : []),
  ];

  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${product}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}${'&nbsp;&zwnj;'.repeat(40)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border-radius:16px;border:1px solid #e5e7eb">
  <tr><td style="padding:28px 28px 8px">
    <p style="margin:0 0 6px;font-size:13px;color:#6b7280">${escapeHtml(storeName)}</p>
    <h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;color:#111827">${first ? `${first}, seu` : 'Seu'} pedido está guardado</h1>
    <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#374151">Vimos que você gerou o Pix para <b>${product}</b>, mas o pagamento ainda não foi concluído. Pode ter sido o tempo do Pix, o app do banco ou só uma interrupção. Acontece.</p>
  </td></tr>
  <tr><td style="padding:0 28px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:12px">
      <tr>
        ${p.productImage ? `<td width="76" style="padding:14px 0 14px 14px"><img src="${escapeHtml(p.productImage)}" width="64" height="64" alt="" style="display:block;width:64px;height:64px;border-radius:10px;object-fit:cover;border:1px solid #e5e7eb"></td>` : ''}
        <td style="padding:14px">
          <p style="margin:0;font-size:15px;font-weight:600;color:#111827">${product}</p>
          ${p.extras?.length ? `<p style="margin:4px 0 0;font-size:13px;color:#6b7280">+ ${p.extras.map(escapeHtml).join(', ')}</p>` : ''}
          <p style="margin:6px 0 0;font-size:18px;font-weight:700;color:${accent}">${price} <span style="font-size:13px;font-weight:400;color:#6b7280">à vista no Pix</span></p>
        </td>
      </tr>
    </table>
  </td></tr>
  <tr><td align="center" style="padding:24px 28px 8px">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="${accent}" style="border-radius:10px">
      <a href="${escapeHtml(p.url)}" target="_blank" style="display:inline-block;padding:14px 30px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px">Pagar meu Pix</a>
    </td></tr></table>
    <p style="margin:10px 0 0;font-size:12px;color:#6b7280">Seu Pix abre direto. Se tiver vencido, gere outro com um toque.</p>
  </td></tr>
  <tr><td style="padding:18px 28px 6px">
    ${benefits.map(([t, d]) => `<p style="margin:0 0 10px;font-size:14px;line-height:1.5;color:#374151"><span style="color:${accent};font-weight:700">&#10003;</span>&nbsp; <b>${escapeHtml(t)}</b>: ${escapeHtml(d)}</p>`).join('')}
  </td></tr>
  <tr><td style="padding:8px 28px 26px">
    <p style="margin:0;font-size:14px;line-height:1.6;color:#374151">Teve alguma dificuldade para pagar? É só responder este e-mail que a gente ajuda.</p>
    <p style="margin:12px 0 0;font-size:13px;color:#6b7280">Se você já pagou, pode ignorar esta mensagem.</p>
  </td></tr>
</table>
<p style="max-width:540px;margin:16px auto 0;font-size:11px;line-height:1.6;color:#9ca3af;text-align:center">
  ${escapeHtml(storeName)}${store.document ? ` · ${escapeHtml(store.document)}` : ''}<br>
  Você recebeu este e-mail porque iniciou uma compra em ${escapeHtml(new URL(env.PUBLIC_URL).host)}.<br>
  <a href="${escapeHtml(unsub)}" style="color:#9ca3af">Não quero mais receber estes e-mails</a>
</p>
</td></tr></table></body></html>`;

  const text = [
    `${firstRaw ? `${firstRaw}, seu` : 'Seu'} pedido está guardado`,
    '',
    `Vimos que você gerou o Pix para ${p.productName}, mas o pagamento ainda não foi concluído.`,
    '',
    `${p.productName}${p.extras?.length ? ` + ${p.extras.join(', ')}` : ''}: ${price} à vista no Pix`,
    '',
    `Pagar meu Pix: ${p.url}`,
    '(seu Pix abre direto; se tiver vencido, gere outro com um toque)',
    '',
    ...benefits.map(([t, d]) => `- ${t}: ${d}`),
    '',
    'Teve alguma dificuldade para pagar? É só responder este e-mail.',
    'Se você já pagou, pode ignorar esta mensagem.',
    '',
    '--',
    storeName,
    `Não quero mais receber estes e-mails: ${unsub}`,
  ].join('\n');

  const from = env.MAIL_FROM ?? env.SMTP_USER ?? '';
  return send(p.to, `${firstRaw ? `${firstRaw}, seu` : 'Seu'} pedido de ${p.productName} ficou pendente`, html, p.orderId, 'recovery', {
    text,
    fromName: storeName,
    replyTo: store.supportEmail || undefined,
    headers: {
      'List-Unsubscribe': `<${unsub}>${from ? `, <mailto:${from}?subject=descadastrar>` : ''}`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'X-Entity-Ref-ID': p.orderId, // evita que o Gmail agrupe/oculte e-mails diferentes
    },
  });
}

/** Monta e envia a recuperação de um pedido (usado pela rotina automática e pelo botão manual). */
export async function sendRecoveryForOrder(o: any) {
  const main = o.items?.find((i: any) => i.kind === 'main');
  return sendRecoveryEmail({
    orderId: o.id,
    to: o.customer.email,
    name: o.customer.name ?? '',
    productName: main?.name ?? 'seu produto',
    productImage: main?.product?.image_url ?? o.checkout?.theme?.mockupUrl ?? null,
    extras: (o.items ?? []).filter((i: any) => i.kind === 'bump').map((i: any) => i.name),
    totalCents: o.total_cents,
    url: `${env.PUBLIC_URL}/pedido/${o.public_token}?utm_source=recovery&utm_medium=email`,
    accent: o.checkout.theme?.primaryColor,
    guaranteeDays: o.checkout.theme?.guaranteeDays ?? 7,
  });
}

export const RECOVERY_ORDER_SELECT = 'id, status, public_token, total_cents, customer_id, customer:customers(name, email), checkout:checkouts(slug, theme), items:order_items(kind, name, product:products(image_url))';

export async function testEmail(to: string) {
  const t = getTransporter();
  if (!t) return { ok: false, message: 'SMTP não configurado' };
  try {
    await t.verify();
    await t.sendMail({
      from: { name: env.MAIL_FROM_NAME, address: env.MAIL_FROM ?? env.SMTP_USER! },
      to,
      subject: 'Teste de e-mail do checkout',
      html: layout('Tudo certo!', '<p>O envio de e-mails do seu checkout está funcionando.</p>'),
    });
    return { ok: true, message: `E-mail de teste enviado para ${to}` };
  } catch (e: any) {
    return { ok: false, message: String(e?.message ?? e) };
  }
}
