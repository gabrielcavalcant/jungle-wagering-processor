import { createApp } from './app';
import { loadConfig } from './config';
import { logger } from './infrastructure/observability/logger';

const config = loadConfig();
createApp()
  .then(async (app) => {
    await app.listen(config.port);
    logger.info({ port: config.port, instanceId: config.instanceId }, 'wagering processor listening');
  })
  .catch((error) => {
    logger.fatal({ err: error instanceof Error ? error.message : String(error) }, 'failed to start');
    process.exit(1);
  });
