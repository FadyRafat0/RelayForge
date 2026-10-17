# Reliability design

RelayForge accepts an event once, persists one obligation per matching endpoint,
and delivers each obligation asynchronously. A successful ingestion response
means that PostgreSQL committed the work. Delivery has a separate lifecycle.

## Problem

Consider an application publishing `payment.succeeded`. Its customer's endpoint
is unavailable for a few minutes. Sending directly from the payment request can
couple payment latency to a remote service, while an in-memory retry disappears
if the process restarts. A request can also succeed remotely while its HTTP reply
is lost, leaving the sender uncertain whether retrying will repeat an effect.

RelayForge separates durable acceptance from outbound HTTP. Each delivery has an
identity, a bounded attempt budget, a due time, and a history that explains how
it reached its current state. Failures become observable obligations to retry or
inspect, rather than disappearing from a request handler.

## Invariants and implementation

| Property | Enforcement | Evidence |
| --- | --- | --- |
| Accepting an event persists its matching delivery obligations together | One PostgreSQL transaction | [Event store](../src/events/store.ts), [event integration tests](../test/integration/events.test.ts) |
| A keyed duplicate cannot silently change an event | Unique idempotency key, conflict handling, payload comparison | [Event store](../src/events/store.ts) |
| Redis publication cannot make pending work disappear | Publish before SQL queue marker; periodically republish stale pending deliveries | [Dispatcher](../src/dispatch/batch.ts) |
| An expired worker cannot overwrite a replacement's result | Durable lease and active-attempt ownership token checked at completion | [Claims](../src/worker/claims.ts), [completion](../src/worker/completion.ts) |
| Rate denial does not consume an HTTP attempt | Admission before claim, durable deferral | [Admission](../src/worker/admission.ts) |
| Receiver retries do not repeat the example SQL effect | Unique receiver/delivery key, receipt and effect in one transaction | [Receiver inbox](../src/receiver/inbox.ts) |
| Replay preserves identity and existing history | State checks, expected attempt count, atomic replay audit | [Delivery store](../src/deliveries/store.ts) |

These are properties of the implemented paths under the tested assumptions.
They are not claims of unlimited retries, exactly-once networking, or immunity
to database/storage loss.

## Why PostgreSQL and Redis have different jobs

PostgreSQL owns events, delivery state, retry schedules, claims, and attempt
history. SQL constraints enforce uniqueness and relationships. Redis Streams
coordinates workers and its pending-entry list supports reclaiming idle jobs.
Redis also runs atomic Lua token buckets shared across workers.

There is no transaction spanning PostgreSQL and Redis. Publishing to Redis first
and then recording the SQL marker admits duplicate jobs if a process crashes
between the operations. Recording the marker first would risk forgetting work
that was never published. The design chooses duplicates plus reconciliation and
idempotent state transitions. This is a polling dispatcher over durable delivery
rows, not an atomic cross-system commit.

Redis AOF `everysec` can lose recent writes on host failure. PostgreSQL's pending
records and stale-marker reconciliation remain necessary even with persistence
enabled. A finite retry budget can still end with a dead delivery.

## Claiming without holding SQL across HTTP

The worker briefly locks a specific due delivery, allocates an attempt, and saves
a 30-second lease plus a unique ownership token. It commits and releases the
database connection before sending the request. HTTP has a five-second deadline.
The result is recorded only while that attempt still owns a valid lease.

A process crash leaves an in-progress attempt. Recovery marks it abandoned and
either schedules a retry or marks the exhausted delivery dead. The abandoned
attempt consumes budget because the receiver may already have processed it.
An expired worker may still have caused a remote effect, so fencing database
completion cannot replace receiver-side idempotency.

## The row-lock handoff bug

The first end-to-end load test found a race that tests which dispatch before
starting a worker had not exposed:

1. The dispatcher locked pending rows and published delivery IDs to Redis.
2. A worker immediately read an ID before the dispatcher's SQL commit.
3. `FOR UPDATE SKIP LOCKED` skipped that specific locked delivery.
4. The worker acknowledged the stream entry even though no attempt occurred.
5. The delivery waited for the 60-second stale-publication reconciliation pass.

The worker now uses `FOR UPDATE` for its specific queued delivery ID. It waits
briefly for the publisher; a database timeout throws and leaves the job
unacknowledged. Another worker's committed claim causes eligibility to be
rechecked, preventing duplicate ownership. Dispatcher and recovery batch scans
retain `SKIP LOCKED` so competing processes can select other available rows.

The [regression test](../test/integration/worker.test.ts) observes a real
PostgreSQL lock wait, confirms the Redis job remains pending while blocked, then
releases the lock and verifies delivery and acknowledgement. The failed pre-fix
run and passing follow-up are retained in [the benchmark report](../benchmarks/RESULTS.md).

## Retries, replay, and order

Transient failures use exponential backoff with equal jitter and a five-minute
cap. HTTP 429/503 honor valid Retry-After minimums. Permanent failures and
exhausted budgets become dead. Replay requires an operator reason and expected
attempt count, adds budget, and preserves the event ID, delivery ID, and history.

The platform does not guarantee delivery order. Concurrent workers and different
retry schedules can reorder related events. Consumers needing ordering must
apply a domain sequence/version rule or the system would need an explicitly
designed partitioning protocol. Changing worker concurrency alone is insufficient.

## Signatures and receiver idempotency

HMAC-SHA256 signs a timestamp, delivery ID, attempt number, and raw body. The
receiver checks freshness and compares signatures in constant time before
processing. HTTP sends validate and pin destination addresses, reject private
and link-local destinations by default, and do not follow redirects.

The example receiver commits a receipt and a SQL business effect together.
Duplicate deliveries with the same body succeed without repeating that effect;
a changed body under the same identity conflicts. External effects such as
sending an email or calling another API need their own idempotency protocol.
HMAC authenticity does not itself make effects idempotent.

## What the benchmarks establish

At five events/sec, the passing baseline completed all 50 deliveries with
8.08 ms API ingestion p95 and 952 ms persisted delivery p95. At 20 events/sec,
all 200 completed, but delivery p95 rose to 9.70 seconds while API ingestion p95
remained 7.51 ms. The default dispatcher publishes up to ten jobs and sleeps one
second each cycle, so a backlog at the higher offered load is expected.

These are short shared-machine measurements. They distinguish acceptance from
delivery and expose a dispatch bottleneck; they do not measure steady-state
maximum capacity. Workload, hardware context, timestamp definitions, and raw
reports are documented in [benchmarks/RESULTS.md](../benchmarks/RESULTS.md).
