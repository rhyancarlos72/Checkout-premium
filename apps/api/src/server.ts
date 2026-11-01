import { env } from './config/env.js';
import { createApp } from './app.js';
import { logger } from './lib/core.js';
import { startJobs } from './services/jobs.js';

const app = createApp();
app.listen(env.PORT, () => {
  logger.info(`Checkout rodando na porta ${env.PORT} (${env.NODE_ENV})`);
  startJobs();
});
