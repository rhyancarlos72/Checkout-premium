import { env } from './config/env.js';
import { createApp } from './app.js';
import { logger } from './lib/core.js';
import { refreshGateways } from './services/gateways.js';
import { startJobs } from './services/jobs.js';

const app = createApp();
// carrega credenciais do painel em segundo plano (o servidor sobe na hora)
void refreshGateways(true).catch(() => {});
app.listen(env.PORT, () => {
  logger.info(`Checkout rodando na porta ${env.PORT} (${env.NODE_ENV})`);
  startJobs();
});
