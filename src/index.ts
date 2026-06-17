import 'dotenv/config';
import { logger } from './logger.js';
import { App } from './app.js';
import { startWebServer } from './web/server.js';

async function main(): Promise<void> {
  // No hard exit when the Anthropic key is missing — the app boots into "setup mode" and the
  // dashboard's first-run wizard collects the key (and the WhatsApp QR). It only spends/connects
  // once a key is entered. This is what makes the app usable without hand-editing .env.
  const app = new App();
  if (app.needsSetup) {
    logger.warn('No Anthropic API key yet — starting in SETUP mode. Open the dashboard to finish setup.');
  }
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
