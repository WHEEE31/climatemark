/**
 * Minimal structured logger.
 *
 * Deliberately dependency-free. The previous implementation used pino with a
 * pino-pretty transport, which spawns a worker thread and needs a bundler
 * plugin to survive being bundled — a common source of "works locally, dies in
 * production" failures. Console output is enough for an app this size and
 * works identically everywhere.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const configured = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
const threshold =
  LEVEL_ORDER[(configured as Level) in LEVEL_ORDER ? (configured as Level) : 'info'];

const isProduction = process.env.NODE_ENV === 'production';

function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function emit(level: Level, context: unknown, message: string): void {
  if (LEVEL_ORDER[level] < threshold) return;

  const details =
    context && typeof context === 'object'
      ? Object.fromEntries(
          Object.entries(context as Record<string, unknown>).map(([k, v]) => [
            k,
            serialize(v),
          ]),
        )
      : undefined;

  if (isProduction) {
    // JSON lines — parseable by hosting platforms' log viewers.
    console.log(
      JSON.stringify({
        level,
        time: new Date().toISOString(),
        message,
        ...(details ?? {}),
      }),
    );
    return;
  }

  const suffix = details && Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
  console.log(`[${level}] ${message}${suffix}`);
}

function makeLogFn(level: Level) {
  return (contextOrMessage: unknown, maybeMessage?: string): void => {
    if (typeof contextOrMessage === 'string') {
      emit(level, undefined, contextOrMessage);
    } else {
      emit(level, contextOrMessage, maybeMessage ?? '');
    }
  };
}

export const logger = {
  debug: makeLogFn('debug'),
  info: makeLogFn('info'),
  warn: makeLogFn('warn'),
  error: makeLogFn('error'),
};

export type Logger = typeof logger;
