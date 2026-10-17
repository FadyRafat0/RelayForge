export interface Config {
  host: string;
  port: number;
  databaseUrl: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
}

// Passing the environment in makes configuration easy to test in isolation.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.HOST ?? '127.0.0.1';
  const portText = env.PORT ?? '3000';
  const port = Number(portText);
  const logLevel = env.LOG_LEVEL ?? 'info';
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  try {
    const url = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length <= 1) {
      throw new Error('Invalid database URL');
    }
  } catch {
    // A connection URL can contain credentials, so never include its value.
    throw new Error('DATABASE_URL must be a PostgreSQL URL with a host and database name');
  }

  if (host.trim().length === 0) throw new Error('HOST must not be empty');
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  if (!['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(logLevel)) {
    throw new Error('LOG_LEVEL must be a supported log level');
  }

  return { host, port, databaseUrl, logLevel: logLevel as Config['logLevel'] };
}
