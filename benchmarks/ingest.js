import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const rate = Number(__ENV.RATE || 5);
const seconds = Number(__ENV.DURATION_SECONDS || 10);
const runId = __ENV.RUN_ID;
if (!Number.isInteger(rate) || rate < 1 || rate > 100 || !Number.isInteger(seconds)
  || seconds < 1 || seconds > 120 || !/^[A-Za-z0-9-]{1,80}$/.test(runId || '')) {
  throw new Error('Use RATE 1..100, DURATION_SECONDS 1..120 and a unique alphanumeric RUN_ID');
}
const accepted = new Counter('accepted_events');
const ingestion = new Trend('ingestion_ms', true);
export const options = {
  scenarios: { ingest: { executor: 'constant-arrival-rate', rate, timeUnit: '1s',
    duration: `${seconds}s`, preAllocatedVUs: 10, maxVUs: 50, gracefulStop: '10s' } },
  thresholds: { http_req_failed: ['rate==0'], checks: ['rate==1'],
    dropped_iterations: ['count==0'], accepted_events: [`count==${rate * seconds}`],
    ingestion_ms: ['p(95)<1000'] },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  // k6 can schedule one iteration at the duration boundary. Keep the submitted
  // workload exact; a missing iteration still fails the accepted-events gate.
  if (exec.scenario.iterationInTest >= rate * seconds) return;
  const response = http.post(`${__ENV.BASE_URL || 'http://127.0.0.1:3100'}/api/events`,
    JSON.stringify({ type: 'benchmark.event', payload: { run_id: runId,
      sequence: exec.scenario.iterationInTest },
    idempotency_key: `${runId}:${exec.scenario.iterationInTest}` }),
    { headers: { 'Content-Type': 'application/json' }, timeout: '5s' });
  ingestion.add(response.timings.duration);
  const valid = check(response, { 'new event committed with exactly one delivery': r => {
    if (r.status !== 201) return false;
    try { const body = r.json(); return body.delivery_count === 1 && body.replayed === false; }
    catch { return false; }
  } });
  if (valid) accepted.add(1);
}

export function handleSummary(data) {
  // The runner captures this marker. No event bodies, credentials or secrets are exported.
  return { stdout: `RELAYFORGE_K6_SUMMARY=${JSON.stringify(data)}\n` };
}
