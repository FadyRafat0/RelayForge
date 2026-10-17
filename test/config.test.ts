import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const databaseUrl = 'postgresql://test:test@localhost/relayforge_test';
const baseEnv = { DATABASE_URL: databaseUrl };

describe('configuration', () => {
  it('uses local development defaults', () => {
    expect(loadConfig(baseEnv)).toEqual({ host: '127.0.0.1', port: 3000, logLevel: 'info', databaseUrl });
  });
  it('reads explicit environment settings', () => {
    expect(loadConfig({ ...baseEnv, HOST: '0.0.0.0', PORT: '8080', LOG_LEVEL: 'debug' }))
      .toEqual({ host: '0.0.0.0', port: 8080, logLevel: 'debug', databaseUrl });
  });
  it.each(['', '0', '-1', '65536', 'abc', '3000.5', '3e3', ' 3000 '])(
    'rejects invalid PORT %j', port => {
      expect(() => loadConfig({ ...baseEnv, PORT: port })).toThrow('PORT');
    },
  );
  it('rejects an empty host', () => {
    expect(() => loadConfig({ ...baseEnv, HOST: '  ' })).toThrow('HOST');
  });
  it('rejects an unsupported log level', () => {
    expect(() => loadConfig({ ...baseEnv, LOG_LEVEL: 'verbose' })).toThrow('LOG_LEVEL');
  });
  it('requires a database URL', () => {
    expect(() => loadConfig({})).toThrow('DATABASE_URL is required');
  });
  it.each(['', 'not-a-url', 'https://localhost/db', 'postgresql://localhost'])('rejects DATABASE_URL %j', value => {
    expect(() => loadConfig({ DATABASE_URL: value })).toThrow('DATABASE_URL');
  });
  it('accepts the postgres URL scheme too', () => {
    const url = 'postgres://test:test@localhost/test';
    expect(loadConfig({ DATABASE_URL: url }).databaseUrl).toBe(url);
  });
  it('does not expose credentials in validation errors', () => {
    expect(() => loadConfig({ DATABASE_URL: 'https://user:private-password@localhost/db' }))
      .toThrow('DATABASE_URL must be a PostgreSQL URL with a host and database name');
  });
});
