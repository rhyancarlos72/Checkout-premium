// Arquivo de entrada para a Hostinger (preset Express → "server.js").
// Ele carrega a API compilada, que também serve o site (React) e escuta em process.env.PORT.
const fs = require('node:fs');
const path = require('node:path');

const entry = path.join(__dirname, 'apps', 'api', 'dist', 'server.js');
if (!fs.existsSync(entry)) {
  console.error('Build não encontrado. Configure o comando de build como: npm run build');
  process.exit(1);
}
import(require('node:url').pathToFileURL(entry).href).catch((err) => {
  console.error('Falha ao iniciar o servidor:', err);
  process.exit(1);
});
