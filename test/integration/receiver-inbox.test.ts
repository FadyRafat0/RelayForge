import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { runMigrations } from '../../src/migrations.js';
import { createReceiverInbox, ReceiverPayloadError } from '../../src/receiver/inbox.js';
import { createChaosReceiver } from '../../src/receiver/app.js';
import { signWebhook } from '../../src/webhooks/signatures.js';
import { createTestDatabase } from '../helpers/database.js';

const secret = 'whsec_' + 'c'.repeat(64);
const body = Buffer.from('{"type":"demo.created","payload":{"amount":100}}');

describe('Durable receiver inbox', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let pool: Pool;
  let connectionString: string;
  let server: ReturnType<typeof createChaosReceiver> | undefined;
  beforeEach(async () => {
    database = await createTestDatabase();
    await runMigrations(database.client);
    const url = new URL(loadConfig().databaseUrl);
    url.searchParams.set('options', `-c search_path=${database.schema}`);
    connectionString = url.toString();
    pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 2000, statement_timeout: 2000 });
  });
  async function stopServer() {
    if (!server?.listening) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    server = undefined;
  }
  afterEach(async () => { await stopServer(); await pool?.end(); await database?.close(); });
  function inbox(receiverId = 'demo') { return createReceiverInbox(pool, receiverId); }
  async function counts() {
    const result = await database.client.query(`SELECT
      (SELECT count(*)::integer FROM receiver_receipts) AS receipts,
      (SELECT count(*)::integer FROM receiver_effects) AS effects`);
    return result.rows[0];
  }
  async function start(onRequest: Parameters<typeof createChaosReceiver>[0] = () => {}) {
    server = createChaosReceiver(onRequest, { signingSecret: secret, inbox: inbox() });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing port');
    return `http://127.0.0.1:${address.port}/webhooks`;
  }
  function headers(deliveryId: string, attemptNumber = 1, rawBody = body) {
    return { 'x-relayforge-delivery-id': deliveryId, 'x-relayforge-attempt': String(attemptNumber),
      'x-relayforge-signature': signWebhook({ secret, body: rawBody, deliveryId, attemptNumber }) };
  }

  it('saves one receipt and one business effect for sequential retries', async () => {
    const id = randomUUID();
    expect(await inbox().receive(id, body, true)).toBe('processed');
    expect(await inbox().receive(id, body, true)).toBe('duplicate');
    expect(await counts()).toEqual({ receipts: 1, effects: 1 });
    const saved = await database.client.query('SELECT event FROM receiver_effects');
    expect(saved.rows[0].event).toEqual(JSON.parse(body.toString()));
  });
  it('handles concurrent duplicate requests from separate inbox instances', async () => {
    const id = randomUUID();
    const results = await Promise.all(Array.from({ length: 20 }, () => inbox().receive(id, body, true)));
    expect(results.filter(result => result === 'processed')).toHaveLength(1);
    expect(results.filter(result => result === 'duplicate')).toHaveLength(19);
    expect(await counts()).toEqual({ receipts: 1, effects: 1 });
  });
  it('rejects reuse of a completed ID with a different body without changing the effect', async () => {
    const id = randomUUID();
    await inbox().receive(id, body, true);
    expect(await inbox().receive(id, Buffer.from('{"amount":200}'), true)).toBe('conflict');
    expect(await counts()).toEqual({ receipts: 1, effects: 1 });
  });
  it('scopes receipts by receiver identity and keeps different deliveries independent', async () => {
    const id = randomUUID();
    await inbox('first').receive(id, body, true);
    await inbox('second').receive(id, body, true);
    await inbox('first').receive(randomUUID(), body, true);
    expect(await counts()).toEqual({ receipts: 3, effects: 3 });
  });
  it('rolls back the receipt when its business effect fails, allowing a later retry', async () => {
    const id = randomUUID();
    await database.client.query('ALTER TABLE receiver_effects ADD CONSTRAINT reject_effect CHECK (false)');
    await expect(inbox().receive(id, body, true)).rejects.toMatchObject({ code: '23514' });
    expect(await counts()).toEqual({ receipts: 0, effects: 0 });
    await database.client.query('ALTER TABLE receiver_effects DROP CONSTRAINT reject_effect');
    expect(await inbox().receive(id, body, true)).toBe('processed');
    expect(await counts()).toEqual({ receipts: 1, effects: 1 });
  });
  it.each(['broken', '[]', 'null', '123'])('rejects non-object JSON without saving a receipt: %s', value => {
    return expect(inbox().receive(randomUUID(), Buffer.from(value), true)).rejects.toBeInstanceOf(ReceiverPayloadError);
  });
  it('does not mark a simulated failed request processed', async () => {
    const id = randomUUID();
    expect(await inbox().receive(id, body, false)).toBe('ignored');
    expect(await counts()).toEqual({ receipts: 0, effects: 0 });
    expect(await inbox().receive(id, body, true)).toBe('processed');
    expect(await inbox().receive(id, body, false)).toBe('duplicate');
  });
  it('preserves a committed effect after a lost HTTP reply and receiver restart', async () => {
    let committed!: () => void;
    const arrived = new Promise<void>(resolve => { committed = resolve; });
    const url = await start(() => committed());
    const id = randomUUID();
    const controller = new AbortController();
    const first = fetch(url + '?mode=slow&delay_ms=10000', { method: 'POST', headers: headers(id),
      body, signal: controller.signal });
    // Attach rejection handling before deliberately aborting the unacknowledged request.
    const lostReply = expect(first).rejects.toThrow();
    await arrived; // Callback runs after the inbox transaction commits, before the delayed response.
    controller.abort();
    await lostReply;
    await stopServer();
    await pool.end();
    pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 2000 });
    const restartedUrl = await start();
    const retry = await fetch(restartedUrl, { method: 'POST', headers: headers(id, 2), body });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ duplicate: true, received: true });
    expect(await counts()).toEqual({ receipts: 1, effects: 1 });
  });
  it('verifies signatures before consulting storage and returns 409 for a signed body conflict', async () => {
    const url = await start();
    const id = randomUUID();
    const unsigned = await fetch(url, { method: 'POST', body });
    expect(unsigned.status).toBe(401);
    expect(await counts()).toEqual({ receipts: 0, effects: 0 });
    expect((await fetch(url, { method: 'POST', headers: headers(id), body })).status).toBe(200);
    // An existing receipt never bypasses signature checks.
    expect((await fetch(url, { method: 'POST', body })).status).toBe(401);
    const changed = Buffer.from('{"changed":true}');
    expect((await fetch(url, { method: 'POST', headers: headers(id, 2, changed), body: changed })).status).toBe(409);
    expect(await counts()).toEqual({ receipts: 1, effects: 1 });
  });
  it('returns 503 on effect failure, then processes a signed retry after recovery', async () => {
    const url = await start();
    const id = randomUUID();
    await database.client.query('ALTER TABLE receiver_effects ADD CONSTRAINT reject_effect CHECK (false)');
    const failed = await fetch(url, { method: 'POST', headers: headers(id), body });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: 'Receiver storage unavailable' });
    expect(await counts()).toEqual({ receipts: 0, effects: 0 });
    await database.client.query('ALTER TABLE receiver_effects DROP CONSTRAINT reject_effect');
    expect((await fetch(url, { method: 'POST', headers: headers(id, 2), body })).status).toBe(200);
    expect(await counts()).toEqual({ receipts: 1, effects: 1 });
  });
  it('rejects a correctly signed malformed body with 400 and no receipt', async () => {
    const url = await start();
    const id = randomUUID();
    const invalid = Buffer.from('{broken');
    const response = await fetch(url, { method: 'POST', headers: headers(id, 1, invalid), body: invalid });
    expect(response.status).toBe(400);
    expect(await counts()).toEqual({ receipts: 0, effects: 0 });
  });
  it('does not persist chaos failures, and acknowledges completed duplicates even in failure mode', async () => {
    const url = await start();
    const id = randomUUID();
    expect((await fetch(url + '?mode=flaky&failures=1', { method: 'POST', headers: headers(id), body })).status).toBe(500);
    expect(await counts()).toEqual({ receipts: 0, effects: 0 });
    expect((await fetch(url, { method: 'POST', headers: headers(id, 2), body })).status).toBe(200);
    expect((await fetch(url + '?mode=status&status=500', { method: 'POST', headers: headers(id, 3), body })).status).toBe(200);
    expect(await counts()).toEqual({ receipts: 1, effects: 1 });
  });
});
