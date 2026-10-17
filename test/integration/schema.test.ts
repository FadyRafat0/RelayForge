import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/migrations.js';
import { createTestDatabase } from '../helpers/database.js';

describe('Webhook database constraints', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let endpointId: string;
  let eventId: string;
  let deliveryId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    await runMigrations(database.client);
  });
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    const client = database.client;
    await client.query('BEGIN');
    const endpoint = await client.query(`INSERT INTO webhook_endpoints (name, url)
      VALUES ('Test receiver', 'https://example.com/webhooks') RETURNING id`);
    endpointId = endpoint.rows[0].id;
    const event = await client.query(`INSERT INTO events (type, payload)
      VALUES ('payment.succeeded', '{"amount":100}') RETURNING id`);
    eventId = event.rows[0].id;
    const delivery = await client.query(`INSERT INTO deliveries (event_id, endpoint_id)
      VALUES ($1, $2) RETURNING id`, [eventId, endpointId]);
    deliveryId = delivery.rows[0].id;
  });
  afterEach(async () => { await database.client.query('ROLLBACK'); });

  it('stores an event, its destination, and the history of a successful delivery', async () => {
    await database.client.query(`INSERT INTO delivery_attempts
      (delivery_id, attempt_number, outcome, http_status, finished_at)
      VALUES ($1, 1, 'succeeded', 200, now())`, [deliveryId]);
    await database.client.query(`UPDATE deliveries SET status = 'succeeded',
      attempt_count = 1, completed_at = now() WHERE id = $1`, [deliveryId]);
    const result = await database.client.query(`SELECT e.type, e.payload, w.name, d.status, a.http_status
      FROM deliveries d JOIN events e ON e.id = d.event_id
      JOIN webhook_endpoints w ON w.id = d.endpoint_id
      JOIN delivery_attempts a ON a.delivery_id = d.id WHERE d.id = $1`, [deliveryId]);
    expect(result.rows).toEqual([{
      type: 'payment.succeeded', payload: { amount: 100 }, name: 'Test receiver',
      status: 'succeeded', http_status: 200,
    }]);
  });

  it('uses pending delivery defaults and supports multiple events without idempotency keys', async () => {
    const result = await database.client.query('SELECT status, attempt_count, max_attempts, completed_at FROM deliveries');
    expect(result.rows).toEqual([{ status: 'pending', attempt_count: 0, max_attempts: 5, completed_at: null }]);
    await database.client.query("INSERT INTO events (type, payload) VALUES ('another.event', '{}')");
  });

  it('rejects duplicate delivery obligations', async () => {
    await expect(database.client.query('INSERT INTO deliveries (event_id, endpoint_id) VALUES ($1, $2)',
      [eventId, endpointId])).rejects.toMatchObject({ code: '23505' });
  });

  it('rejects duplicate event idempotency keys', async () => {
    await database.client.query("UPDATE events SET idempotency_key = 'client-request-1' WHERE id = $1", [eventId]);
    await expect(database.client.query(`INSERT INTO events (type, payload, idempotency_key)
      VALUES ('payment.succeeded', '{}', 'client-request-1')`)).rejects.toMatchObject({ code: '23505' });
  });

  it.each(['event', 'endpoint'])('rejects a missing %s on a delivery', async missing => {
    await expect(database.client.query('INSERT INTO deliveries (event_id, endpoint_id) VALUES ($1, $2)',
      [missing === 'event' ? randomUUID() : eventId, missing === 'endpoint' ? randomUUID() : endpointId]))
      .rejects.toMatchObject({ code: '23503' });
  });

  it('rejects attempts for a nonexistent delivery', async () => {
    await expect(database.client.query('INSERT INTO delivery_attempts (delivery_id, attempt_number) VALUES ($1, 1)',
      [randomUUID()])).rejects.toMatchObject({ code: '23503' });
  });

  it('keeps referenced endpoint history from being deleted', async () => {
    await expect(database.client.query('DELETE FROM webhook_endpoints WHERE id = $1', [endpointId]))
      .rejects.toMatchObject({ code: '23001' });
  });

  it.each([
    "UPDATE deliveries SET status = 'unknown'",
    'UPDATE deliveries SET attempt_count = -1',
    'UPDATE deliveries SET attempt_count = 6',
    "UPDATE deliveries SET status = 'succeeded'",
    "UPDATE events SET payload = '[]'::jsonb",
    "UPDATE webhook_endpoints SET event_types = ARRAY[]::text[]",
    "UPDATE webhook_endpoints SET url = 'ftp://example.com'",
  ])('enforces CHECK constraints: %s', async sql => {
    await expect(database.client.query(sql)).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects duplicate attempt numbers for the same delivery', async () => {
    const sql = 'INSERT INTO delivery_attempts (delivery_id, attempt_number) VALUES ($1, 1)';
    await database.client.query(sql, [deliveryId]);
    await expect(database.client.query(sql, [deliveryId])).rejects.toMatchObject({ code: '23505' });
  });

  it('rejects a successful attempt without a successful HTTP status', async () => {
    await expect(database.client.query(`INSERT INTO delivery_attempts
      (delivery_id, attempt_number, outcome, http_status, finished_at)
      VALUES ($1, 1, 'succeeded', 500, now())`, [deliveryId]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('updates the modification timestamp automatically', async () => {
    const before = await database.client.query('SELECT updated_at FROM webhook_endpoints WHERE id = $1', [endpointId]);
    const after = await database.client.query(`UPDATE webhook_endpoints SET enabled = false
      WHERE id = $1 RETURNING updated_at`, [endpointId]);
    expect(after.rows[0].updated_at.getTime()).toBeGreaterThanOrEqual(before.rows[0].updated_at.getTime());
  });
});
