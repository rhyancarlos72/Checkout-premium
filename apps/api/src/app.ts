import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { HttpError, logger } from './lib/core.js';
import { adminRouter } from './routes/admin.js';
import { publicRouter } from './routes/public.js';
import { webhookRouter } from './routes/webhooks.js';
import { runJobs } from './services/jobs.js';
import crypto from 'node:crypto';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  const supabaseHost = new URL(env.SUPABASE_URL).origin;
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'", 'https://connect.facebook.net'],
          'img-src': ["'self'", 'data:', 'blob:', 'https:'],
          'connect-src': ["'self'", supabaseHost, supabaseHost.replace('https://', 'wss://'), 'https://www.facebook.com', 'https://connect.facebook.net'],
          'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
          'frame-src': ["'self'", 'https://www.facebook.com'],
          'frame-ancestors': ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  const origins = [env.PUBLIC_URL, ...env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)];
  app.use('/api', cors({ origin: (o, cb) => cb(null, !o || origins.includes(o)), credentials: false }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => !req.url?.startsWith('/api') } }));
  app.use(express.json({ limit: '200kb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, env: env.NODE_ENV }));
  app.use('/api/public', publicRouter);
  app.use('/api/webhooks', webhookRouter);
  app.use('/api/admin', adminRouter);

  // Cron externo (opcional): Hostinger/cron-job.org → POST /api/jobs/run com header x-cron-secret
  app.post('/api/jobs/run', async (req, res) => {
    const given = Buffer.from(req.get('x-cron-secret') ?? '');
    const expected = Buffer.from(env.CRON_SECRET ?? '');
    if (!env.CRON_SECRET || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    await runJobs();
    res.json({ ok: true });
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota não encontrada' }));

  // Frontend (build do Vite) servido pelo mesmo app → um único deploy na Hostinger
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.resolve(here, '../../web/dist');
  if (fs.existsSync(webDist)) {
    app.use('/assets', express.static(path.join(webDist, 'assets'), { immutable: true, maxAge: '1y' }));
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json({ error: err.issues[0]?.message ?? 'Dados inválidos', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    if ((err as any)?.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
    req.log?.error({ err }, 'Erro não tratado');
    res.status(500).json({ error: 'Erro interno. Tente novamente.' });
  });

  return app;
}
