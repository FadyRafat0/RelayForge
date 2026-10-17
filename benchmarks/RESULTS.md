# Measured local results

Measured on 2026-10-17. These are actual short local runs, not maximum-capacity or availability claims. Raw reports include all k6 summary metrics, thresholds, counts, timestamps, workload settings, and application image identity.

| Run | Offered events/s | Submitted | Successful / receiver effects | Ingestion p95 | Delivery p50 | Delivery p95 | Completion rate | Result |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| [Before lock fix](results/handoff-before-fix.json) | 5 | 50 | 48 / 48 | 10.78 ms | 60572.21 ms | 121424.04 ms | 0.37/s | Fail |
| [Baseline](results/baseline.json) | 5 | 50 | 50 / 50 | 8.08 ms | 537.34 ms | 952.15 ms | 4.83/s | Pass |
| [Queued load](results/queued.json) | 20 | 200 | 200 / 200 | 7.51 ms | 5146.78 ms | 9700.97 ms | 10.14/s | Pass |

## Reproduce

```sh
npm run benchmark -- --rate 5 --seconds 10 --output baseline.json
npm run benchmark -- --rate 20 --seconds 10 --output queued.json
```

Each run starts fresh PostgreSQL 18 and Redis 8 databases, uses one worker with concurrency 4 and one immediate-success receiver, and sends for ten seconds with no warmup. The endpoint limit is 1000/s. The dispatcher publishes batches of up to ten and sleeps one second per cycle. Both passing runs had zero dead deliveries, zero unfinished deliveries, exactly one attempt/effect per event, no HTTP failures, and no dropped k6 iterations.

## Environment

Node v24.21.0, k6 v1.0.0, Linux amd64 containers on Docker Desktop / WSL2, 16 logical CPUs visible to Docker and 8,161,759,232 bytes of Docker memory (about 7.60 GiB). No per-container CPU limits were applied. All components and the load generator shared one local machine. Images and exact environment details are recorded in each JSON report. Background machine activity and short run duration limit reproducibility; these are single observations, not confidence intervals.

## What the measurements show

The first run exposed a dispatcher/worker row-lock handoff bug: the worker skipped a row still locked by the publishing dispatcher, acknowledged the stream job, and depended on 60-second reconciliation to try again. After the load stopped and the runner waited up to 120 seconds, only 48 of 50 deliveries had succeeded; two remained pending. Its delivery percentiles are calculated only over the 48 visible receiver effects, so the failed run must not be described as having delivered all events at that latency. The report preserves that failure instead of presenting its fast API latency as success.

The fix changes the worker claim for a specific queued ID to wait on `FOR UPDATE`, with the existing database command timeout. Dispatcher batch selection retains `SKIP LOCKED`. A real PostgreSQL/Redis regression test verifies that the worker waits, does not acknowledge while blocked, and completes after the publishing lock is released. The passing baseline delivered 50/50 events.

At 20 events/s, the API still ingests quickly while the default dispatcher produces a growing backlog. All 200 deliveries eventually succeed, but delivery p95 reaches approximately 9.7 seconds. Completion throughput stays near the dispatcher polling pace. More worker concurrency alone would not remove that bottleneck. This is an observed design limit with the default batch/poll policy, not a worker capacity benchmark.

## Measurement definitions and limits

Ingestion latency is the request duration reported by k6. Delivery latency is the persisted timestamp difference from `events.created_at` to `receiver_effects.applied_at`. Both use PostgreSQL transaction-start timestamps, rather than exact commit instants; the report is queried after records commit. Completion rate is successes divided by the finite interval from the earliest selected event timestamp to the latest selected receiver effect timestamp. Neither measure is a steady-state capacity estimate.

These runs use one tiny payload, one endpoint, no failures in the passing runs, and shared sender/receiver PostgreSQL. They do not measure long-duration saturation, many-endpoint fairness, remote network latency, crash recovery under load, or data durability after host failure. Correctness/failure-path integration tests cover separate scenarios. Repeat runs and vary payload size, endpoint count, receiver latency, concurrency, and dispatcher policy before making broader performance claims.

See the [load testing guide](../docs/load-testing.md) for thresholds, cleanup, timestamp semantics, and k6 arrival-rate behavior.
