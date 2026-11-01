import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z
    .string()
    .optional()
    .transform((v) => (['development', 'staging', 'production', 'test'].includes(v ?? '') ? v : 'production') as 'development' | 'staging' | 'production' | 'test'),
  PORT: z.coerce.number().default(3000),
  /** URL pública do site (ex.: https://checkout.seudominio.com) — usada em webhooks e e-mails */
  PUBLIC_URL: z
    .string()
    .url()
    .transform((v) => v.replace(/\/+$/, '')),
  /** Origens extras liberadas no CORS (separadas por vírgula). O próprio PUBLIC_URL já é liberado. */
  CORS_ORIGINS: z.string().optional().default(''),
  TRUST_PROXY: z.coerce.number().default(1),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  /** Chave pública (anon/publishable) — entregue ao navegador via /config.js */
  SUPABASE_ANON_KEY: z.string().optional(),
  VITE_SUPABASE_ANON_KEY: z.string().optional(),

  // ---- Woovi (OpenPix)
  WOOVI_APP_ID: z.string().optional(),
  WOOVI_API_URL: z.string().url().default('https://api.openpix.com.br'),
  /** Valor que você configura como "Authorization" do webhook no painel Woovi (opcional, recomendado) */
  WOOVI_WEBHOOK_SECRET: z.string().optional(),

  // ---- Efí Bank (Pix API, mTLS)
  EFI_CLIENT_ID: z.string().optional(),
  EFI_CLIENT_SECRET: z.string().optional(),
  EFI_PIX_KEY: z.string().optional(),
  /** Certificado .p12 em base64 (ex.: `base64 -w0 certificado.p12`) */
  EFI_CERT_BASE64: z.string().optional(),
  /** Alternativa: caminho do .p12 fora da pasta pública */
  EFI_CERT_PATH: z.string().optional(),
  EFI_CERT_PASSPHRASE: z.string().optional().default(''),
  EFI_SANDBOX: bool,
  /** Segredo enviado como ?hmac= na URL do webhook registrada na Efí */
  EFI_WEBHOOK_SECRET: z.string().optional(),

  // ---- PayTracking
  PAYTRACKING_URL: z.string().url().optional(),
  PAYTRACKING_TOKEN: z.string().optional(),
  PAYTRACKING_SECRET: z.string().optional(),

  // ---- E-mail (SMTP — ex.: Hostinger smtp.hostinger.com:465)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(465),
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  MAIL_FROM_NAME: z.string().default('Checkout'),

  /** Liga os jobs (expiração, conciliação e recuperação). Desligue se rodar várias instâncias. */
  JOBS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  /** Token para disparar jobs por cron externo: POST /api/jobs/run com header x-cron-secret */
  CRON_SECRET: z.string().optional(),
  /** E-mail do dono. Só ele pode fazer o "Primeiro acesso" (criar o 1º admin pelo painel). */
  ADMIN_EMAIL: z
    .string()
    .email()
    .optional()
    .transform((v) => v?.trim().toLowerCase()),
});

// Variáveis vazias (ex.: `PAYTRACKING_URL=` copiado do .env.example) contam como não definidas
const cleaned = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== ''));
const parsed = schema.safeParse(cleaned);
if (!parsed.success) {
  // Mostra só os NOMES das variáveis com problema, nunca valores.
  const fields = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
  console.error(`Variáveis de ambiente inválidas:\n  ${fields}`);
  // Lança (em vez de encerrar) para o server.js da raiz exibir uma página de diagnóstico.
  throw Object.assign(new Error(`Variáveis de ambiente inválidas:\n  ${fields}`), { code: 'ENV_INVALID' });
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';

export const features = {
  woovi: Boolean(env.WOOVI_APP_ID),
  efi: Boolean(env.EFI_CLIENT_ID && env.EFI_CLIENT_SECRET && env.EFI_PIX_KEY && (env.EFI_CERT_BASE64 || env.EFI_CERT_PATH)),
  paytracking: Boolean(env.PAYTRACKING_URL && env.PAYTRACKING_TOKEN),
  email: Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS),
};
