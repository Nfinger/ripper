import { pino, stdTimeFunctions } from 'pino';

export const log = pino({
  level: process.env.SYMPHONY_LOG_LEVEL ?? 'info',
  base: { service: 'symphony' },
  formatters: {
    level: (label: string) => ({ level: label }),
  },
  timestamp: stdTimeFunctions.isoTime,
});

export type Logger = typeof log;
