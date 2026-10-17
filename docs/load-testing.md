# Reproducible load testing

```sh
npm run benchmark -- --rate 5 --seconds 10 --output baseline.json
npm run benchmark -- --rate 20 --seconds 10 --output queued.json
```

Requires Node.js 24 and Docker. No local k6 installation or cloud account is
needed. The runner creates a unique Compose project, uses an ephemeral host API
port and separate PostgreSQL/Redis volumes, builds the application, runs the
pinned `grafana/k6:1.0.0` load generator, waits up to 120 seconds for delivery,
writes a JSON report under `benchmarks/results`, and removes only its own project
and volumes. It never resets your development or demo database. If the process
is forcibly terminated, use the exact project name printed at startup to inspect
and clean up the interrupted benchmark, rather than pruning unrelated Docker data.

`RATE` is limited to 1..100 requests/s and duration to 1..120 seconds. Each request
has one small payload, one subscribed endpoint, and a unique idempotency key.
The default receiver succeeds immediately, verifies HMAC, and commits its inbox
receipt and example SQL effect. Runs start from empty databases with no warmup.
The application uses one worker process, concurrency 4, a 1000/s endpoint bucket,
and the default dispatcher batch of 10 followed by a 1000ms poll delay.

k6 uses [constant arrival rate](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/):
the test attempts to start requests on a schedule independently of response time.
`dropped_iterations` detects insufficient load-generator capacity. Each response
must be 201 with exactly one delivery and `replayed: false`. Thresholds require
zero HTTP failures, zero dropped iterations, the exact accepted event count, and
ingestion p95 below 1000ms. These are smoke-test gates, not production SLOs.
The script caps submitted requests at rate times duration because k6 can schedule
an additional iteration at the duration boundary. Missing scheduled work still
fails the accepted-count gate; extra boundary iterations send no request.
The runner additionally fails if the database does not show the expected number
of successful deliveries and unique receiver effects after draining.

Two different latency measures matter:

- **Ingestion latency** (`k6.metrics.ingestion_ms`): HTTP request time observed by
  k6. A 201 means durable acceptance, not completed webhook delivery.
- **Delivery latency** (`delivery.p50_ms/p95_ms/p99_ms`): PostgreSQL
  `receiver_effects.applied_at - events.created_at`, queried only after rows are
  visible. Both timestamps use the same database clock and represent transaction
  start times, not exact commit instants. This persisted timestamp proxy includes
  dispatch wait, worker scheduling, HTTP and receiver processing up to its
  transaction start; it does not include receiver commit/HTTP reply time.

`completed_per_second` divides successful deliveries by the interval from the
earliest selected event timestamp to the latest receiver effect timestamp.
It is an observed completion rate for this finite workload. It is not a measured
maximum capacity or a steady-state throughput claim. The outer observed duration
also includes load-generator container startup and final database polling.

At 20 requests/s, the default dispatcher can publish at most about 10 per polling
cycle, and publishing itself takes time. A backlog and rising delivery latency
are therefore expected even if the API stays fast. Increasing worker concurrency
alone cannot fix a dispatcher bottleneck. Tune batch/poll behavior only after
measuring the relevant queue lag and SQL/Redis costs.

The full raw [k6 custom summary](https://grafana.com/docs/k6/latest/results-output/end-of-test/custom-summary/)
is stored with each report, alongside runtime/image identity, Docker CPU/memory,
workload settings, counts and latency percentiles. Reports contain no signing
secrets or payloads. See [measured results](../benchmarks/RESULTS.md) for runs made
in this checkout. Repeat runs and longer tests are needed before drawing capacity
conclusions; one local machine running every component is not a production fleet.

The first test exposed a lock-handoff race: after publishing a job, the dispatcher
still held the delivery row lock until commit. A worker using `SKIP LOCKED` could
skip the pending row and acknowledge the job, postponing it until reconciliation.
The worker now waits on its specific delivery row; command timeouts leave failed
processing unacknowledged. Dispatcher's multi-row selection still uses
`SKIP LOCKED`, where it correctly permits independent dispatchers to select other
available rows. A regression test observes a real PostgreSQL lock wait and
verifies that acknowledgement happens only after the lock is released and the
delivery succeeds. The failed pre-fix report is retained as evidence.
