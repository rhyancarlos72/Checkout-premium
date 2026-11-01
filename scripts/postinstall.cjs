// Roda o build logo após `npm install` — a Hostinger (preset Express) não tem
// campo de "comando de build": ela só instala as dependências e inicia o server.js.
// Para pular (ex.: desenvolvimento local): SKIP_POSTINSTALL_BUILD=1 npm install
const { execSync } = require('node:child_process');

if (process.env.SKIP_POSTINSTALL_BUILD === '1') {
  console.log('[postinstall] build ignorado (SKIP_POSTINSTALL_BUILD=1)');
  process.exit(0);
}
try {
  console.log('[postinstall] compilando site e API…');
  execSync('npm run build', { stdio: 'inherit', cwd: require('node:path').join(__dirname, '..') });
} catch {
  // Não derruba a instalação: o server.js tenta compilar de novo na inicialização
  // e, se falhar, mostra uma página de diagnóstico.
  console.error('[postinstall] o build falhou; o server.js tentará novamente ao iniciar.');
}
