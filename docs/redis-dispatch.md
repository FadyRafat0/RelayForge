# Checkpoint 3A: Redis Streams and dispatch

## The idea

PostgreSQL records the work RelayForge owes. Redis coordinates when workers pick up that work. The API does not write directly to Redis: an event and its deliveries commit in PostgreSQL first, and a separate dispatcher publishes delivery IDs afterward.

```text
POST /api/events -> PostgreSQL events + pending deliveries
                                      |
                                 dispatcher
                                      |
                              Redis Stream jobs
                                      |
                                  workers
```

A Redis Stream is an ordered log of entries. `XADD` appends one entry and gives it a stream ID. Our entry has one field, `delivery_id`. It contains no event payload, URL, or credentials. The Redis stream ID identifies one publication; the PostgreSQL delivery UUID identifies the logical work. Several publications may refer to the same delivery.

## Start and inspect

```powershell
npm run services:up
npm run db:migrate
npm run dev
```

Register an endpoint and submit an event using the examples in the API guides. In a separate terminal:

```powershell
npm run dispatch:once
docker compose exec redis redis-cli XLEN relayforge:deliveries
docker compose exec redis redis-cli XRANGE relayforge:deliveries - + COUNT 10
```

`dispatch:once` publishes one batch, at most ten deliveries, and prints `{ "published": <count> }`. Zero is normal if there is no eligible work. It does not drain an unlimited backlog.

For a running dispatcher that polls every second:

```powershell
npm run dispatcher
```

Ctrl+C requests shutdown. Let the current bounded batch finish, then close connections. Errors stop this process with a nonzero exit status; after restoring the service, restart the dispatcher. Automatic process supervision comes later. The Redis client fails rather than maintaining a hidden offline command queue. Workers now consume these entries; see worker.md for their lifecycle.

Only the dispatcher requires REDIS_URL (`redis://127.0.0.1:6379` locally). The API and its health check still require only PostgreSQL, so ingestion can succeed during a Redis outage. Redis runs in a Linux container with a named volume. AOF persistence appends writes to disk and fsyncs every second; a host failure can still lose recent Redis writes. Reconciliation from PostgreSQL handles pending work that loses its queue entry.

## Dispatch selection and locking

An eligible delivery has:

- status `pending`;
- next_attempt_at at or before the database's current time;
- no queue marker, or a marker at least 60 seconds old.

The dispatcher checks out one PostgreSQL connection, begins a transaction, and selects a bounded batch with `FOR UPDATE SKIP LOCKED`. Row locks prevent concurrent dispatchers from claiming the same rows during that transaction. SKIP LOCKED lets another dispatcher take different rows instead of waiting. The selected rows stay locked while Redis publications run; this is a simple starting design with small batches and command timeouts, not a benchmarked scaling strategy.

For each row:

1. Append its delivery ID to the Redis Stream.
2. Record last_enqueued_at and last_stream_id in PostgreSQL.
3. Commit the batch once all publications and updates succeed.

The new SQL migration, 002_dispatch_tracking.sql, adds those two columns. It does not edit the already applied initial migration. The delivery remains pending: queue publication is not successful HTTP delivery and does not create an attempt.

## Why duplicates are intentional

PostgreSQL and Redis do not share a transaction. We cannot atomically commit both with this design.

| Failure point | Result |
| --- | --- |
| Before Redis accepts a job | Database marker rolls back; a later dispatcher run retries |
| Redis accepts a job but its reply is lost | Marker rolls back; retry can append a duplicate |
| Redis accepts a job, then PostgreSQL marking or commit fails | Same delivery can be published again |
| Dispatcher process dies during its transaction | PostgreSQL releases locks and rolls back when the connection closes; published jobs may remain |
| Redis loses entries after markers commit | Pending deliveries become eligible again after the 60-second reconciliation interval |

Markers are scheduling hints, not proof of permanent queue retention. Without reconciliation, a permanent "queued" flag could strand work after Redis data loss. We deliberately republish stale pending work, even if its previous stream entry still exists. The worker uses consumer groups, durable leases, ownership checks, and pending-job reclaim to manage duplicate jobs. Before each dispatch batch, the dispatcher now recovers a bounded batch of expired worker leases; see worker-leases.md.

Without a running worker, a continuously running dispatcher adds duplicate entries for still-pending deliveries every reconciliation interval. Use one-shot dispatch for experiments and stop continuous dispatch when done. Workers now skip completed or locked deliveries and acknowledge duplicates. We do not trim the stream yet because deleting entries before a retention policy exists could remove needed work. This is not an exactly-once system or a complete production queue.

## Try an outage

Stop a running dispatcher first. Leave the API running:

```powershell
npm run redis:stop
```

Submit a new event: PostgreSQL still accepts it. `npm run dispatch:once` fails while Redis is unavailable. Restore Redis and run the dispatcher again:

```powershell
npm run services:up
npm run dispatch:once
```

The pending delivery is now published. Nothing needs to be resubmitted to the ingestion API. Reuse the same idempotency key if a client does retry its event submission.

## Files and tests

- src/queue/config.ts: Redis URL configuration, separate from API configuration.
- src/queue/redis.ts: connection lifecycle and timeout-bounded XADD.
- src/dispatch/batch.ts: row selection, locks, publications, markers, rollback, release.
- src/dispatcher.ts: one-shot or polling process and shutdown.
- migrations/002_dispatch_tracking.sql: queue tracking columns.

Start both services before `npm run test:integration`. Dispatch tests use isolated PostgreSQL schemas and random Redis stream names. They delete only their own keys, never flush Redis. They check bounded/disjoint batches, eligibility, publication errors, lost acknowledgements, database failure after publication, stream-loss reconciliation, and locked-row skipping. The stream-loss test advances a database timestamp instead of sleeping for a minute.

References: [Redis Streams](https://redis.io/docs/latest/develop/data-types/streams/), [Redis persistence](https://redis.io/docs/latest/management/persistence/), [node-redis production behavior](https://redis.io/docs/latest/develop/clients/nodejs/produsage/), [PostgreSQL row locking](https://www.postgresql.org/docs/18/sql-select.html).
