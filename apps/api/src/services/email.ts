import nodemailer, { type Transporter } from 'nodemailer';
import { env, features } from '../config/env.js';
import { escapeHtml, formatBRL, logger, supabase } from '../lib/core.js';

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

async function send(to: string, subject: string, html: string, orderId: string, event: string) {
  const t = getTransporter();
  if (!t) {
    await supabase.from('integration_logs').insert({ integration: 'email', order_id: orderId, event, ok: false, message: 'SMTP não configurado' });
    return false;
  }
  try {
    await t.sendMail({ from: { name: env.MAIL_FROM_NAME, address: env.MAIL_FROM ?? env.SMTP_USER! }, to, subject, html });
    await supabase.from('integration_logs').insert({ integration: 'email', order_id: orderId, event, ok: true, message: 'enviado' });
    return true;
  } catch (e: any) {
    logger.error({ err: e?.message, orderId }, 'Falha ao enviar e-mail');
    await supabase.from('integration_logs').insert({ integration: 'email', order_id: orderId, event, ok: false, message: String(e?.message ?? e).slice(0, 300) });
    return false;
  }
}

export interface DeliveryItem {
  name: string;
  url: string | null;
  note: string | null;
}

export function sendDeliveryEmail(p: { orderId: string; orderNumber: number; to: string; name: string; items: DeliveryItem[]; accessUrl: string; accent?: string }) {
  const first = escapeHtml(p.name.split(' ')[0] ?? '');
  const list = p.items
    .map(
      (i) => `<div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin:12px 0">
        <div style="font-weight:600;margin-bottom:8px">${escapeHtml(i.name)}</div>
        ${i.note ? `<div style="color:#4b5563;font-size:14px;margin-bottom:12px">${escapeHtml(i.note)}</div>` : ''}
        ${i.url ? button(i.url, 'Acessar agora') : '<div style="color:#6b7280;font-size:14px">O acesso será enviado em breve.</div>'}
      </div>`,
    )
    .join('');
  const html = layout(
    'Pagamento aprovado! 🎉',
    `<p style="font-size:15px;line-height:1.6">Olá, ${first}! Seu pagamento do pedido <b>#${p.orderNumber}</b> foi confirmado. Aqui está o seu acesso:</p>
     ${list}
     <p style="font-size:13px;color:#6b7280;margin-top:20px">Você também pode acessar seus produtos a qualquer momento por <a href="${escapeHtml(p.accessUrl)}">esta página</a>.</p>`,
    p.accent,
  );
  return send(p.to, `Acesso liberado — pedido #${p.orderNumber}`, html, p.orderId, 'delivery');
}

export function sendRecoveryEmail(p: { orderId: string; to: string; name: string; productName: string; totalCents: number; url: string; accent?: string }) {
  const first = escapeHtml(p.name.split(' ')[0] ?? '');
  const html = layout(
    'Seu pedido está quase pronto',
    `<p style="font-size:15px;line-height:1.6">Olá, ${first}! Notamos que o pagamento de <b>${escapeHtml(p.productName)}</b> (${formatBRL(p.totalCents)}) ainda não foi concluído.</p>
     <p style="font-size:15px;line-height:1.6">Seu pedido continua reservado. Finalize em poucos segundos pelo PIX:</p>
     <p style="margin:24px 0">${button(p.url, 'Finalizar pagamento')}</p>
     <p style="font-size:13px;color:#6b7280">Se você já pagou, desconsidere esta mensagem.</p>`,
    p.accent,
  );
  return send(p.to, `Finalize seu pedido: ${p.productName}`, html, p.orderId, 'recovery');
}

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
