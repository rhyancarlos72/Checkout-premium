import { env } from './config/env.js';
import { createApp } from './app.js';
import { logger } from './lib/core.js';
import { efi } from './providers/index.js';
import { refreshGateways } from './services/gateways.js';
import { startJobs } from './services/jobs.js';

const app = createApp();
// carrega credenciais do painel em segundo plano (o servidor sobe na hora)
// e já abre a conexão com a Efí (token + mTLS), para o primeiro Pix sair sem espera
const warmEfi = () => void efi.warm().catch(() => {});
void refreshGateways(true).then(warmEfi).catch(() => {});
setInterval(warmEfi, 5 * 60_000).unref();
app.listen(env.PORT, () => {
  logger.info(`Checkout rodando na porta ${env.PORT} (${env.NODE_ENV})`);
  startJobs();
});
