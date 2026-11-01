// Arquivo de entrada para a Hostinger (preset Express → "server.js").
// Carrega a API compilada, que serve o site (React) e a API em process.env.PORT.
// Se algo impedir a inicialização (build ausente, variável faltando), sobe uma
// página de diagnóstico em vez de cair — assim você vê o motivo no navegador
// em vez de "503 Service Unavailable". Nunca exibe VALORES de variáveis.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const entry = path.join(__dirname, 'apps', 'api', 'dist', 'server.js');
const webIndex = path.join(__dirname, 'apps', 'web', 'dist', 'index.html');

function startDiagnostics(title, detail) {
  console.error(`[checkout] ${title}\n${detail}`);
  const required = ['PUBLIC_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY'];
  const rows = required
    .map((k) => `<tr><td><code>${k}</code></td><td>${process.env[k] || process.env['VITE_' + k] ? '✅ definida' : '❌ <b>faltando</b>'}</td></tr>`)
    .join('');
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Checkout — configuração pendente</title>
<body style="font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#111">
<h1 style="font-size:22px">⚠️ ${esc(title)}</h1>
<pre style="background:#f4f4f5;padding:12px;border-radius:8px;white-space:pre-wrap">${esc(detail)}</pre>
<h2 style="font-size:16px">Variáveis obrigatórias</h2>
<table cellpadding="6" style="border-collapse:collapse">${rows}</table>
<p style="color:#555">Build do site: ${fs.existsSync(webIndex) ? '✅ encontrado' : '❌ não encontrado'}<br>
Build da API: ${fs.existsSync(entry) ? '✅ encontrado' : '❌ não encontrado'}<br>Node: ${process.version} (use 22)</p>
<p style="color:#555">Corrija no painel da Hostinger (variáveis de ambiente) e faça o redeploy. </p>
</body>`;
  http
    .createServer((req, res) => {
      res.writeHead(req.url === '/api/health' ? 503 : 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    })
    .listen(process.env.PORT || 3000);
}

// Se o build não rodou na instalação, compila agora (leva alguns segundos).
if (!fs.existsSync(entry) || !fs.existsSync(webIndex)) {
  try {
    console.log('[checkout] build não encontrado — compilando…');
    require('node:child_process').execSync('npm run build', { stdio: 'inherit', cwd: __dirname });
  } catch (e) {
    /* tratado abaixo */
  }
}

if (!fs.existsSync(entry)) {
  startDiagnostics('Build não encontrado', 'Não foi possível compilar o projeto (apps/api/dist/server.js ausente). Verifique se o Node é 22 e veja o log da instalação.');
} else {
  import(pathToFileURL(entry).href).catch((err) => {
    startDiagnostics('O servidor não conseguiu iniciar', err && err.message ? err.message : String(err));
  });
}
