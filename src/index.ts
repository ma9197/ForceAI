import 'dotenv/config';
import { logger } from './logger.js';
import { App } from './app.js';
import { startWebServer } from './web/server.js';

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.error('ANTHROPIC_API_KEY is not set — copy .env.example to .env and fill it in');
    process.exit(1);
  }

  const app = new App();
  await startWebServer(app);
  await app.start();

  const shutdown = async () => {
    logger.info('shutting down');
    await app.conn.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
