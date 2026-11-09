import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import compression from 'compression';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import { escapeHtml, HttpError, logger, parseShortOrderCode, supabase } from './lib/core.js';
import { publicCheckoutData } from './routes/public.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { publicRouter } from './routes/public.js';
import { webhookRouter } from './routes/webhooks.js';
import { refreshGateways } from './services/gateways.js';
import { runJobs } from './services/jobs.js';
import crypto from 'node:crypto';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  // gzip/brotli-like: respostas JSON e arquivos do site até ~70% menores
  app.use(compression({ threshold: 1024 }));

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
          'style-src': ["'self'", "'unsafe-inline'"],
          'font-src': ["'self'", 'data:'],
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

  // credenciais dos gateways configuradas no painel (cache de 30s)
  // recarrega em segundo plano: nenhuma requisição espera o banco por causa disso
  app.use('/api', (_req, _res, next) => {
    void refreshGateways().catch(() => {});
    next();
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, env: env.NODE_ENV }));
  app.use('/api/public', publicRouter);
  app.use('/api/webhooks', webhookRouter);
  app.use('/api/auth', authRouter);
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

  // Configuração pública do frontend lida em tempo de execução (não depende do build).
  // Só valores públicos: URL do projeto e chave anon. A service role NUNCA sai do servidor.
  app.get('/config.js', (_req, res) => {
    const cfg = { supabaseUrl: env.SUPABASE_URL, supabaseAnonKey: env.SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_ANON_KEY ?? '' };
    res.type('application/javascript').set('Cache-Control', 'public, max-age=300');
    res.send(`window.__APP_CONFIG__=${JSON.stringify(cfg)};`);
  });

  // Link curto do pedido: /r/aZ3kQg8 (lembrete de recuperação) e /p/aZ3kQg8 (acesso).
  // Valida a assinatura e leva para a página do Pix/acesso do pedido; a origem fica nas UTMs.
  // limite por IP: um cliente abre o link poucas vezes; impede tentar adivinhar códigos em massa
  const shortLinkLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false, keyGenerator: (req) => ipKeyGenerator(req.ip ?? '0.0.0.0') });
  app.get(/^\/(r|p)\/([0-9A-Za-z]{6,16})$/, shortLinkLimiter, async (req, res) => {
    const [, kind, code] = req.path.match(/^\/(r|p)\/([0-9A-Za-z]{6,16})$/)!;
    const n = parseShortOrderCode(code);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (!n) return res.redirect(302, '/');
    const { data } = await supabase.from('orders').select('public_token').eq('number', n).maybeSingle();
    if (!data) return res.redirect(302, '/');
    const qs = kind === 'r' ? '?utm_source=whatsapp&utm_medium=recovery' : '';
    res.redirect(302, `/pedido/${(data as any).public_token}${qs}`);
  });

  // Frontend (build do Vite) servido pelo mesmo app → um único deploy na Hostinger
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.resolve(here, '../../web/dist');
  if (fs.existsSync(webDist)) {
    app.use('/assets', express.static(path.join(webDist, 'assets'), { immutable: true, maxAge: '1y' }));
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    // CSS embutido no HTML: o navegador pinta a página sem esperar outro arquivo (sem "render-blocking")
    let html: { mtime: number; body: string } | null = null;
    const indexHtml = () => {
      const file = path.join(webDist, 'index.html');
      const mtime = fs.statSync(file).mtimeMs;
      if (html?.mtime === mtime) return html.body;
      let body = fs.readFileSync(file, 'utf8');
      body = body.replace(/<link rel="stylesheet"[^>]*href="(\/assets\/[^"]+\.css)"[^>]*>/g, (tag, href: string) => {
        const css = path.join(webDist, href);
        if (!css.startsWith(webDist) || !fs.existsSync(css)) return tag;
        return `<style>${fs.readFileSync(css, 'utf8').replace(/<\/style/gi, '<\\/style')}</style>`;
      });
      html = { mtime, body };
      return body;
    };
    // robots.txt válido (antes caía no index.html): checkout pode ser indexado; painel, pedidos e API não
    app.get('/robots.txt', (_req, res) => {
      res.type('text/plain').set('Cache-Control', 'public, max-age=3600');
      res.send(['User-agent: *', 'Allow: /', 'Disallow: /admin', 'Disallow: /pedido/', 'Disallow: /api/', ''].join('\n'));
    });

    // llms.txt (orientação para assistentes de IA): Markdown com H1 e links das páginas públicas
    app.get('/llms.txt', async (_req, res) => {
      let name = 'Checkout';
      try {
        const { getSettings } = await import('./services/settings.js');
        const st = await getSettings();
        name = (st.store?.name && st.store.name !== 'Minha Loja' ? st.store.name : st.brand?.name) || name;
      } catch {
        /* sem banco: nome padrão */
      }
      const base = env.PUBLIC_URL.replace(/\/+$/, '');
      res.type('text/markdown; charset=utf-8').set('Cache-Control', 'public, max-age=3600');
      res.send(
        [
          `# ${name}`,
          '',
          '> Checkout seguro com pagamento via Pix e entrega automática do produto digital por e-mail e WhatsApp.',
          '',
          'As páginas de checkout são públicas. O painel administrativo e as páginas de pedidos (com dados de clientes) não devem ser acessados nem indexados.',
          '',
          '## Páginas',
          '',
          `- [Checkout](${base}/checkout): página de compra de cada produto (\`/checkout?produto_id=ID\`), pagamento via Pix`,
          `- [Política de robôs](${base}/robots.txt): o que pode ser rastreado`,
          '',
          '## Não acessar',
          '',
          `- [Painel administrativo](${base}/admin): acesso restrito`,
          '',
        ].join('\n'),
      );
    });

    // Arquivos que não existem (ex.: /.well-known/ai-catalog.json, /favicon.png) respondem 404 de verdade,
    // em vez de devolver o HTML do site (que validadores leem como "arquivo inválido")
    app.get(/^\/(\.well-known\/.*|.+\.(json|txt|xml|webmanifest|ico|png|jpe?g|gif|svg|webp|js|css|map|woff2?))$/i, (_req, res) => {
      res.status(404).type('text/plain').send('Não encontrado');
    });

    // SEO por página: título/descrição/prévia de link (WhatsApp, Facebook) do produto no checkout;
    // painel e páginas de Pix de cada cliente ficam fora do Google (dados pessoais)
    const seoFor = async (req: Request) => {
      const p = req.path;
      if (/^\/(admin|pedido)(\/|$)/.test(p)) return { noindex: true } as const;
      const slug = p === '/checkout' ? String(req.query.produto_id ?? '') : (p.match(/^\/c\/([a-z0-9-]{3,60})$/)?.[1] ?? '');
      if (!/^[a-z0-9-]{3,60}$/.test(slug)) return null;
      try {
        const c: any = await Promise.race([publicCheckoutData(slug), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500))]);
        const name = c.theme?.headline || c.product?.name || c.name;
        const desc = String(c.theme?.subheadline || c.product?.description || `Compre ${name} com pagamento via Pix e acesso imediato.`).replace(/\s+/g, ' ').slice(0, 155);
        const banner: string | null = c.theme?.bannerUrl || c.theme?.mockupUrl || null;
        return { title: `${name} | Checkout seguro`, desc, image: c.product?.image_url || c.theme?.mockupUrl || null, url: `${env.PUBLIC_URL}/checkout?produto_id=${slug}`, banner, data: c };
      } catch {
        return null;
      }
    };
    const setMeta = (html: string, prop: string, attr: 'name' | 'property', value: string) => {
      const re = new RegExp(`<meta ${attr}="${prop}" content="[^"]*" \\/>`);
      const tag = `<meta ${attr}="${prop}" content="${escapeHtml(value)}" />`;
      return re.test(html) ? html.replace(re, tag) : html.replace('</head>', `    ${tag}\n  </head>`);
    };
    app.get(/^\/(?!api\/).*/, async (req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      let body = indexHtml();
      const seo = await seoFor(req);
      if (seo && 'noindex' in seo) {
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        body = body.replace('</head>', '    <meta name="robots" content="noindex, nofollow" />\n  </head>');
      } else if (seo) {
        body = body.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(seo.title)}</title>`);
        body = setMeta(body, 'description', 'name', seo.desc);
        body = setMeta(body, 'og:title', 'property', seo.title);
        body = setMeta(body, 'og:description', 'property', seo.desc);
        body = setMeta(body, 'og:url', 'property', seo.url);
        if (seo.image) {
          body = setMeta(body, 'og:image', 'property', seo.image);
          body = setMeta(body, 'twitter:card', 'name', 'summary_large_image');
        }
        body = body.replace('</head>', `    <link rel="canonical" href="${escapeHtml(seo.url)}" />\n  </head>`);
        // LCP: o navegador começa a baixar o banner junto com o HTML (antes esperava o JS + a API)
        // sem "crossorigin": as imagens do Storage são baixadas sem CORS, e um preconnect com crossorigin
        // abre uma conexão que as imagens não usam
        const preload = [`<link rel="preconnect" href="${supabaseHost}" />`];
        if (seo.banner) preload.push(`<link rel="preload" as="image" href="${escapeHtml(seo.banner)}" fetchpriority="high" />`);
        body = body.replace('<head>', `<head>\n    ${preload.join('\n    ')}`);
        // dados do checkout já no HTML (bloco JSON, não executável): a página monta sem esperar a API
        const json = JSON.stringify({ slug: seo.data.slug, data: seo.data }).replace(/</g, '\\u003c');
        body = body.replace('<div id="root"></div>', `<div id="root"></div>\n    <script type="application/json" id="ck-data">${json}</script>`);
      }
      res.type('html').send(body);
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
