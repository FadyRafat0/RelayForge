# Checkpoint 6A: structured logs and delivery metrics

Logs explain one occurrence: which delivery failed, what attempt it was, and
what happened next. Metrics summarize system state: how much work is due,
how many deliveries are dead, and whether leases have expired. We now have both
without adding a dashboard or a monitoring server to the local stack.

## PostgreSQL-backed metrics

`GET /metrics` returns Prometheus text format with HELP and TYPE metadata and
12 samples across six metric families:

| Metric | Meaning |
| --- | --- |
| relayforge_deliveries{status="..."} | Delivery rows in pending, processing, succeeded, or dead state |
| relayforge_attempts{outcome="..."} | Attempt rows currently in progress, succeeded, failed, or abandoned |
| relayforge_deliveries_due | Pending deliveries due now, with an enabled endpoint and remaining attempt budget |
| relayforge_oldest_due_delivery_lag_seconds | Time since the oldest eligible delivery's scheduled due time; zero if none |
| relayforge_expired_leases | Processing deliveries whose worker lease has expired |
| relayforge_delivery_replays | Retained manual replay audit rows |

Every family is a **gauge**, a value that can go down. Replaying a dead delivery
reduces the dead count; completing an attempt reduces the in-progress count.
Even retained history counts are exposed as snapshots, not monotonic counters.
Do not apply counter rate calculations to these metrics. A future latency
histogram or event counter would serve a different purpose.

One SQL statement reads a consistent database snapshot using one statement
timestamp. Metrics survive API and worker restarts because they are derived
from durable rows rather than process-local increments. Labels use only fixed
states/outcomes: no delivery IDs, endpoint IDs, URLs, event types, or payloads.
This keeps the number of time series bounded. See
[Prometheus instrumentation guidance](https://prometheus.io/docs/practices/instrumentation/).

Multiple API instances report the same database-wide state. Do not sum those
replicas' values as if they represented independent delivery populations.

Due-work lag starts from `next_attempt_at`, not event creation. Scheduled
backoff and rate-limit deferrals are not overdue until that timestamp passes.
Disabled endpoints are excluded from due count/lag but remain in the overall
pending count. A growing due lag suggests investigating dispatcher/worker
progress, quotas, or capacity. Expired leases suggest interrupted workers and
recovery work. These signals guide investigation rather than prove a cause.

## Scrape and failure behavior

```powershell
Invoke-RestMethod 'http://127.0.0.1:3000/metrics'
```

```sh
curl -i http://127.0.0.1:3000/metrics
```

Successful responses have `Content-Type: text/plain; version=0.0.4; charset=utf-8`
and `Cache-Control: no-store`. Query filters are rejected. No external Prometheus
process is required to inspect this endpoint; a future Prometheus deployment
can periodically scrape it.

If collection fails, the route returns 503 with a generic JSON error, not
invented zero values. `/health` still checks only PostgreSQL connectivity.
For example, missing migration tables can make metrics fail while health passes.
Redis availability and its pending-entry list are not measured by this route.

The collector aggregates retained PostgreSQL rows and uses the existing API
pool and query timeouts. Its cost grows with stored history. Frequent scrapes
can add database load; preaggregation, exporter isolation, and retention can be
introduced after measuring that cost. This endpoint uses the application's
current local API access model.

## Structured JSON logs

The API, worker, dispatcher, and standalone lease-recovery command now use Pino,
the JSON logger Fastify already uses. It is an explicit dependency for these
CLI processes. Each record has a service name, process ID, level, and timestamp.
`LOG_LEVEL` applies to them all: debug adds detailed starts/claims, info includes
completed outcomes, error includes processing/infrastructure failures, and
silent suppresses logger output.

| Event | Useful fields |
| --- | --- |
| api.request_completed | reqId, method, registered route pattern, status_code, duration_ms |
| endpoint.registered | reqId, endpoint_id, rate_limit_per_second |
| event.accepted | reqId, event_id, delivery_count, replayed |
| delivery.replay_accepted | reqId, delivery_id, replay_id, attempt_count, max_attempts |
| delivery.claimed (debug) | worker_id, delivery_id, endpoint_id, event_id, attempt_id, attempt_number |
| delivery.processed | Same available IDs, outcome, observed http_status, durations, and applied retry decision |
| delivery.processing_failed | Available IDs, normalized error_code, duration_ms |
| worker.job_acknowledged | consumer, stream_id, delivery_id when valid, outcome, active_jobs |
| worker.job_failed | consumer, stream_id, delivery_id when valid, normalized error_code |
| dispatcher.batch_completed | published, recovered, duration_ms |
| recovery.completed | recovered |

Lifecycle events record worker/dispatcher startup, stop requests where applicable,
and draining. API request IDs link API events within a request. Event IDs connect
ingestion to later worker records; delivery and attempt IDs distinguish the
individual delivery and its retries. Stream IDs distinguish duplicate queue
publications of that same delivery.

`delivery.processed` follows the database result. It does not mean Redis XACK
succeeded; `worker.job_acknowledged` is a separate event after acknowledgement.
An HTTP 200 paired with `lost_lease` is an observed receiver response, not an
authorized database completion. A failed database completion does not emit a
successful processed event. Rate-limited/skipped jobs need not have attempt IDs.

`duration_ms` measures processing through database completion, including
admission when present, but excludes queue waiting and acknowledgement.
`http_duration_ms` measures the sender call, including its DNS/network/response
work. These use a monotonic clock and are observations, not benchmark results
or end-to-end delivery latency percentiles.

Only stable IDs, bounded decisions, statuses, and measured timings are added to
delivery events. Payloads, signing secrets, destination URLs, idempotency keys,
and replay reasons are omitted. API completion logs use route patterns rather
than raw paths, queries, or headers. Raw exception messages/stacks are replaced
by normalized codes, and known secret/payload fields are defensively redacted.
Receiver-simulator output and migration-command messages retain their existing
formats.

Telemetry observers are best effort. A failing observer does not change saved
delivery state, create a retry, or prevent acknowledgement. Logs can be missing
after a process crash or output failure; PostgreSQL remains the source of truth.

## Try a failure investigation

Use the existing signed receiver in flaky mode, submit an event, and run the
dispatcher and worker. In another terminal, read `/metrics` before and after
delivery. Inspect JSON lines in the worker terminal by delivery_id:

1. Find event.accepted in the API output and note event_id.
2. Find matching delivery.processed records in worker output.
3. Follow attempt_number, outcome, http_status, reason, and retry_delay_ms.
4. Check worker.job_acknowledged for that stream publication.
5. Compare with delivery/attempt inspection APIs and the aggregate metrics.

For detailed claim records in PowerShell, set `$env:LOG_LEVEL = 'debug'` before
starting the worker. Restart existing API/CLI processes to pick up this phase.
No new database migration is required.

Tests cover empty snapshots, eligible lag, claims, expired-lease recovery,
retry/success history, replay transitions, and unavailable metric tables. Log
tests check correlation, durations, sensitive-data omission, acknowledgement
failures, lost leases, and observer exceptions. The new tests run in the existing
GitHub Actions workflow.

The reproducible k6 workload and measured local results are now available in
[load-testing.md](load-testing.md) and [the benchmark report](../benchmarks/RESULTS.md).
