import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

describe('showcase evidence', () => {
  it('preserves actual attempt histories and effect counts for all four scenarios', async () => {
    const text = await read('showcase/traces.json');
    expect(text).not.toMatch(/whsec_|signing_secret|DATABASE_URL|password/);
    const data = JSON.parse(text);
    expect(data.backend_revision).toMatch(/^[0-9a-f]{40}$/);
    expect(Number.isNaN(Date.parse(data.recorded_at))).toBe(false);
    expect(data.disclosure).toContain('does not run a live');
    const expected = {
      success: { status: 'succeeded', codes: [200], effects: 1 },
      retry: { status: 'succeeded', codes: [500, 500, 200], effects: 1 },
      dead: { status: 'dead', codes: [400], effects: 0 },
      replay: { status: 'succeeded', codes: [400, 200], effects: 1 },
    };
    expect(data.scenarios).toHaveLength(4);
    expect(new Set(data.scenarios.map((scenario: { key: string }) => scenario.key)).size).toBe(4);
    for (const scenario of data.scenarios) {
      const expectedCase = expected[scenario.key as keyof typeof expected];
      expect(expectedCase).toBeDefined();
      expect(scenario.status).toBe(expectedCase.status);
      expect(scenario.attempts.map((attempt: { http_status: number }) => attempt.http_status)).toEqual(expectedCase.codes);
      expect(scenario.attempt_count).toBe(expectedCase.codes.length);
      expect(scenario.receiver_effects).toBe(expectedCase.effects);
      expect(scenario.acceptance_status).toBe(201);
      expect(scenario.duplicate_submission_status).toBe(scenario.key === 'success' ? 200 : null);
      expect(scenario.replays.length).toBe(scenario.key === 'replay' ? 1 : 0);
      for (const [index, attempt] of scenario.attempts.entries()) {
        expect(attempt.attempt_number).toBe(index + 1);
        expect(Date.parse(attempt.started_at)).toBeGreaterThanOrEqual(Date.parse(scenario.created_at));
        expect(Date.parse(attempt.finished_at)).toBeGreaterThanOrEqual(Date.parse(attempt.started_at));
      }
    }
  });

  it('shows benchmark values from the raw reports without rounding or inventing evidence', async () => {
    const data = JSON.parse(await read('showcase/benchmarks.json'));
    expect(data.runs).toHaveLength(2);
    for (const run of data.runs) {
      expect(run.source).toMatch(/^benchmarks\/results\/(baseline|queued)\.json$/);
      const source = JSON.parse(await read(run.source));
      expect(source.passed).toBe(true);
      expect(run.rate).toBe(source.workload.rate);
      expect(run.expected).toBe(source.workload.expected_events);
      expect(run.succeeded).toBe(source.delivery.succeeded);
      expect(run.ingestion_p95_ms).toBe(source.k6.metrics.ingestion_ms.values['p(95)']);
      expect(run.delivery_p95_ms).toBe(source.delivery.p95_ms);
    }
  });
});
