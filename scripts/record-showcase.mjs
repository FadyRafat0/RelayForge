import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';

// Capture real delivery histories, never generated sample outcomes. Each run owns
// its entire Compose project and removes only those disposable resources.
const root = fileURLToPath(new URL('../', import.meta.url));
const project = `relayforge-record-${randomUUID().slice(0, 8)}`;
const env = { ...process.env, DEMO_PORT: '0', DEMO_LOG_LEVEL: 'silent', DEMO_WORKER_CONCURRENCY: '4' };
function command(program, args, allowFailure = false) {
  return new Promise((resolve, reject) => {
    execFile(program, args, { cwd: root, env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !allowFailure) reject(new Error(`${program} failed: ${stderr || stdout}`));
      else resolve({ stdout, stderr, exitCode: error?.code ?? 0 });
    });
  });
}
const compose = (args, allowFailure = false) => command('docker', ['compose', '-f', 'compose.demo.yaml', '-p', project, ...args], allowFailure);
async function sql(query) {
  const result = await compose(['exec', '-T', 'postgres', 'psql', '-U', 'relayforge', '-d', 'relayforge', '-Atc', query]);
  return result.stdout.trim();
}
async function api(path, body, method = 'POST') {
  const code = `const r=await fetch('http://127.0.0.1:3000${path}',${JSON.stringify({ method,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })});
    console.log(JSON.stringify({status:r.status,body:await r.json()}));if(!r.ok)process.exitCode=1;`;
  return JSON.parse((await compose(['exec', '-T', 'api', 'node', '--input-type=module', '-e', code])).stdout);
}
async function waitFor(id, status) {
  const deadline = performance.now() + 60000;
  do {
    const current = await sql(`SELECT status FROM deliveries WHERE id = '${id}'`);
    if (current === status) return;
    if (current === 'dead' && status === 'succeeded') throw new Error('Unexpected dead delivery');
    await setTimeout(300);
  } while (performance.now() < deadline);
  throw new Error(`Delivery did not reach ${status}`);
}
try {
  console.log(`Recording real backend traces in ${project}`);
  await compose(['up', '-d', '--build', '--wait', '--wait-timeout', '180']);
  const revision = (await command('git', ['-c', `safe.directory=${root.replaceAll('\\', '/').replace(/\/$/, '')}`, 'rev-parse', 'HEAD'])).stdout.trim();
  const scenarios = [];
  for (const [key, title, query] of [
    ['success', 'Successful delivery', ''],
    ['retry', 'Transient failure and recovery', '?mode=flaky&failures=2'],
    ['dead', 'Permanent failure', '?mode=status&status=400'],
    ['replay', 'Repair and audited replay', '?mode=status&status=400'],
  ]) {
    console.log(`Recording ${key}`);
    const endpointId = randomUUID();
    // Isolated receiver verifies the provisioned demo key. Clone that key only
    // inside this disposable recording project; never export it in trace data.
    await sql(`INSERT INTO webhook_endpoints (id,name,url,event_types,signing_secret,rate_limit_per_second)
      SELECT '${endpointId}', 'Recorded ${key}', 'http://127.0.0.1:8080/webhooks${query}',
      ARRAY['showcase.${key}'], signing_secret, 1000 FROM webhook_endpoints
      WHERE id = '00000000-0000-4000-8000-000000000001'`);
    const input = { type: `showcase.${key}`, payload: { order_id: 'order-1042' }, idempotency_key: `record-${key}` };
    const accepted = await api('/api/events', input);
    if (accepted.status !== 201 || accepted.body.delivery_count !== 1) throw new Error('Unexpected event acceptance');
    const deliveryId = await sql(`SELECT id FROM deliveries WHERE event_id = '${accepted.body.event.id}'`);
    let duplicate = null;
    if (key === 'success') {
      duplicate = await api('/api/events', input);
      if (duplicate.status !== 200 || !duplicate.body.replayed || duplicate.body.event.id !== accepted.body.event.id) {
        throw new Error('Idempotency check failed');
      }
    }
    await waitFor(deliveryId, key === 'dead' || key === 'replay' ? 'dead' : 'succeeded');
    if (key === 'replay') {
      await api(`/api/endpoints/${endpointId}`, { url: 'http://127.0.0.1:8080/webhooks' }, 'PATCH');
      const reopened = await api(`/api/deliveries/${deliveryId}/replay`, {
        expected_attempt_count: 1, additional_attempts: 2, reason: 'Corrected receiver configuration' });
      if (reopened.status !== 202) throw new Error('Replay was not accepted');
      await waitFor(deliveryId, 'succeeded');
    }
    const data = JSON.parse(await sql(`SELECT row_to_json(result) FROM (SELECT
      d.id, ev.type AS event_type, d.status, d.attempt_count, d.created_at, d.completed_at,
      (SELECT count(*)::integer FROM receiver_effects e WHERE e.delivery_id=d.id) AS receiver_effects,
      (SELECT COALESCE(json_agg(a ORDER BY a.attempt_number),'[]'::json) FROM
        (SELECT attempt_number,outcome,http_status,started_at,finished_at
         FROM delivery_attempts WHERE delivery_id=d.id) a) AS attempts,
      (SELECT COALESCE(json_agg(r ORDER BY r.replayed_at),'[]'::json) FROM
        (SELECT reason,previous_attempt_count,additional_attempts,replayed_at
         FROM delivery_replays WHERE delivery_id=d.id) r) AS replays
      FROM deliveries d JOIN events ev ON ev.id=d.event_id WHERE d.id='${deliveryId}') result`));
    const expectedAttempts = key === 'retry' ? 3 : key === 'replay' ? 2 : 1;
    if (data.attempt_count !== expectedAttempts || data.receiver_effects !== (key === 'dead' ? 0 : 1)) {
      throw new Error('Recorded history did not match the required scenario');
    }
    scenarios.push({ key, title, acceptance_status: accepted.status, duplicate_submission_status: duplicate?.status ?? null, ...data });
  }
  const result = { recorded_at: new Date().toISOString(), backend_revision: revision,
    provenance: 'Actual isolated Docker run: PostgreSQL, Redis Streams, HTTP worker, HMAC-verifying receiver.',
    disclosure: 'Recorded demonstration. This website does not run a live delivery backend.', scenarios };
  await writeFile(new URL('../showcase/traces.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log('Verified four real histories and wrote showcase/traces.json; no secrets exported.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  const cleanup = await compose(['down', '--volumes', '--remove-orphans', '--timeout', '20'], true);
  if (cleanup.exitCode !== 0) { console.error(cleanup.stderr); process.exitCode = 1; }
}
