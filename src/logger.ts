import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV === 'production' ? undefined : {
    target: 'pino/file', // plain stdout; pino-pretty not required
    options: { destination: 1 },
  },
});

/** Baileys is extremely chatty at info level — give it its own quieter child. */
export const waLogger = logger.child({ module: 'baileys' });
waLogger.level = process.env.WA_LOG_LEVEL ?? 'error';
