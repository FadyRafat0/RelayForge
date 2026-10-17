import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout } from 'node:timers/promises';

const { values } = parseArgs({ options: { rate: { type: 'string', default: '5' },
  seconds: { type: 'string', default: '10' }, output: { type: 'string', default: 'last-run.json' } } });
const rate = Number(values.rate), seconds = Number(values.seconds);
if (!Number.isInteger(rate) || rate < 1 || rate > 100 || !Number.isInteger(seconds) || seconds < 1 || seconds > 120) {
  throw new Error('Use --rate 1..100 and --seconds 1..120');
}
if (!/^[a-zA-Z0-9._-]+\.json$/.test(values.output)) throw new Error('--output must be a JSON filename');
const root = fileURLToPath(new URL('../', import.meta.url));
const runId = `bench-${randomUUID()}`;
const project = `relayforge-${runId}`;
const env = { ...process.env, DEMO_PORT: '0', DEMO_LOG_LEVEL: 'silent',
  DEMO_WORKER_CONCURRENCY: '4',
  BENCHMARK_RUN_ID: runId, BENCHMARK_RATE: String(rate), BENCHMARK_SECONDS: String(seconds) };
const composeArgs = ['compose', '-f', 'compose.demo.yaml', '-p', project];

function docker(args, allowFailure = false) {
  return new Promise((resolveResult, reject) => {
    execFile('docker', args, { cwd: root, env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !allowFailure) reject(new Error(`docker ${args.slice(0, 3).join(' ')} failed: ${stderr || stdout}`));
      else resolveResult({ stdout, stderr, exitCode: error?.code ?? 0 });
    });
  });
}
const compose = (args, allowFailure = false) => docker([...composeArgs, ...args], allowFailure);

// runId is generated here from a UUID, never accepted from SQL or HTTP input.
const sql = `WITH selected AS (
  SELECT d.*, e.created_at AS accepted_at FROM deliveries d JOIN events e ON e.id = d.event_id
  WHERE e.payload->>'run_id' = '${runId}'
), counts AS (SELECT count(*)::integer AS total,
  count(*) FILTER (WHERE status = 'succeeded')::integer AS succeeded,
  count(*) FILTER (WHERE status = 'dead')::integer AS dead,
  count(*) FILTER (WHERE status IN ('pending','processing'))::integer AS unfinished,
  COALESCE(sum(attempt_count),0)::integer AS attempts FROM selected
), effects AS (SELECT count(*)::integer AS effects,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (r.applied_at - d.accepted_at))*1000) AS p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (r.applied_at - d.accepted_at))*1000) AS p95_ms,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM (r.applied_at - d.accepted_at))*1000) AS p99_ms,
  max(extract(epoch FROM (r.applied_at - d.accepted_at))*1000) AS max_ms,
  extract(epoch FROM (max(r.applied_at) - min(d.accepted_at))) AS delivery_window_seconds
  FROM selected d JOIN receiver_effects r ON r.delivery_id = d.id AND r.receiver_id = 'docker-demo')
SELECT row_to_json(result) FROM (SELECT counts.*, effects.* FROM counts CROSS JOIN effects) result`;
async function snapshot() {
  const result = await compose(['exec', '-T', 'postgres', 'psql', '-U', 'relayforge', '-d', 'relayforge', '-Atc', sql]);
  return JSON.parse(result.stdout.trim());
}

let failed = false;
try {
  console.log(`Starting isolated benchmark ${runId}: ${rate} events/s for ${seconds}s`);
  await compose(['up', '-d', '--build', '--wait', '--wait-timeout', '180']);
  const info = JSON.parse((await docker(['info', '--format', '{{json .}}'])).stdout);
  const node = (await compose(['exec', '-T', 'api', 'node', '--version'])).stdout.trim();
  const k6Version = (await compose(['run', '--rm', '-T', '--no-deps', 'k6', 'version'])).stdout.trim();
  const imageId = (await docker(['image', 'inspect', 'relayforge:local', '--format', '{{.Id}}'])).stdout.trim();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const result = await compose(['run', '--rm', '-T', '--no-deps', 'k6', 'run', '--quiet', '/bench/ingest.js'], true);
  const marker = result.stdout.split(/\r?\n/).find(line => line.startsWith('RELAYFORGE_K6_SUMMARY='));
  if (!marker) throw new Error(`k6 produced no summary: ${result.stderr}`);
  const summary = JSON.parse(marker.slice('RELAYFORGE_K6_SUMMARY='.length));
  console.log('Ingestion finished; waiting up to 120 seconds for durable receiver effects.');
  const deadline = performance.now() + 120000;
  let delivery;
  do {
    delivery = await snapshot();
    if (delivery.unfinished === 0 && delivery.total > 0) break;
    await setTimeout(500);
  } while (performance.now() < deadline);
  const thresholdsPassed = Object.values(summary.metrics).every(metric =>
    Object.values(metric.thresholds ?? {}).every(threshold => threshold.ok));
  const expected = rate * seconds;
  const passed = result.exitCode === 0 && thresholdsPassed && delivery.total === expected
    && delivery.succeeded === expected && delivery.effects === expected && delivery.dead === 0;
  const report = { runId, startedAt, completedAt: new Date().toISOString(), passed,
    workload: { rate, seconds, expected_events: expected, endpoints: 1, worker_processes: 1,
      worker_concurrency: 4, endpoint_rate_per_second: 1000, receiver: 'success',
      dispatcher_batch: 10, dispatcher_poll_ms: 1000, warmup: 'none' },
    environment: { node, k6: k6Version, application_image: imageId,
      docker_cpus: info.NCPU, docker_memory_bytes: info.MemTotal,
      docker_os: info.OperatingSystem, kernel: info.KernelVersion, architecture: info.Architecture,
      cpu_limits: 'none; shared local Docker Desktop resources' },
    observed_seconds_including_drain: (performance.now() - started) / 1000,
    delivery: { ...delivery, completed_per_second: delivery.delivery_window_seconds > 0
      ? delivery.succeeded / delivery.delivery_window_seconds : null },
    k6: summary,
  };
  const output = resolve(root, 'benchmarks', 'results', values.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed, output, ingestion_p95_ms: summary.metrics.ingestion_ms?.values['p(95)'],
    delivery_p95_ms: delivery.p95_ms, succeeded: delivery.succeeded, expected }, null, 2));
  failed = !passed;
} catch (error) {
  failed = true;
  console.error(error.message);
  // Failure evidence stays on screen; never export connection URLs or receiver secrets.
  const logs = await compose(['logs', '--tail', '20', 'worker', 'dispatcher', 'api'], true);
  console.error(logs.stdout);
} finally {
  console.log('Removing only this benchmark project and its disposable volumes.');
  const cleanup = await compose(['down', '--volumes', '--remove-orphans', '--timeout', '20'], true);
  if (cleanup.exitCode !== 0) { failed = true; console.error(cleanup.stderr); }
}
if (failed) process.exitCode = 1;
