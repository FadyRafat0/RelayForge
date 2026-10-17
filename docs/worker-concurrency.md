# Checkpoint 5B: bounded worker concurrency

Concurrency is how many jobs can be in progress at once. Rate is how quickly new
attempts are admitted to an endpoint. We need both: a slow receiver can occupy
several jobs even at a modest request rate, while a fast receiver can receive
many sequential requests without high concurrency.

One worker process now runs up to four jobs concurrently by default. Set
`WORKER_CONCURRENCY` to an integer from 1 to 16 to change that bound. This is
asynchronous I/O on Node's event loop; it does not introduce CPU worker threads.
While one job waits for HTTP, another can progress through admission or SQL.

## One reader, bounded slots

```text
                     one queue reader
                            |
                  only read with a free slot
                            |
                 +----------+----------+
                 |          |          |
               job 1      job 2      ... job C
                 |          |          |
            admission -> claim -> HTTP -> completion -> XACK
                            |
                  release slot after XACK
```

`src/worker/run.ts` tracks active tasks in a Set. When all slots are occupied,
it waits for one task to finish before reading another message. It does not
fetch the entire backlog or create an unbounded Promise.all over deliveries.
Only one queue read is outstanding, so reclaim cursor updates remain serial.

A slot includes admission, claiming, HTTP, completion, and acknowledgement.
It is released only after acknowledgement succeeds or the task fails. The
existing `consumeJob` helper preserves process-before-ack behavior, including
acknowledging malformed messages without database work.

There is one Redis consumer identity per process, and it can own several
pending stream messages. Other worker processes still use distinct identities
in the same consumer group. With two processes configured for four slots each,
up to eight jobs can be in progress across them. Their endpoint token buckets
remain shared. No delivery-order guarantee is introduced: jobs can complete
out of order, and retries can also reorder deliveries.

## Redis and PostgreSQL connections

The queue now has two Redis connections: one for read/reclaim, and one for group
setup and acknowledgements. Admission has its own connection, for three Redis
connections per CLI worker. A blocking XREADGROUP on the reader therefore does
not hold acknowledgements behind it. See [Redis XREADGROUP](https://redis.io/docs/latest/commands/xreadgroup/).

The PostgreSQL worker pool stays bounded at two connections. HTTP does not hold
a database connection, so four active jobs do not require four connections.
The limiter also waits for Redis outside a PostgreSQL transaction. Under load,
jobs can wait for the pool; existing connection/query timeouts and lease fencing
still apply. These are initial settings, not measured capacity recommendations.

## Shutdown and failures

SIGINT (Ctrl+C) and SIGTERM request a graceful stop:

1. Stop starting new reads and processing newly returned jobs.
2. Let already active jobs finish their bounded operations and acknowledge their
   saved outcomes.
3. Close the queue, limiter, and database pool after all active tasks settle.

A read already in progress is not cancelled. Its one-second BLOCK and command
deadlines bound the wait. If it returns a job after the stop was requested,
the worker leaves it pending without allocating an attempt or acknowledging it.
Stream reclaim or stale-pending dispatcher reconciliation can recover that work.

A processing, acknowledgement, or read error stops new admission to the runner.
The runner records the first error, drains active peers, then reports failure;
the CLI exits with nonzero status. Successful peers may still commit and
acknowledge normally. Every task handles its rejection immediately, preventing
unhandled background promise rejections while draining.

If acknowledgement fails after database success, reclaiming the old message
skips the completed delivery. If a claim was committed but processing cannot
complete, existing lease recovery preserves the abandoned attempt. A hard
process kill cannot drain; the same crash-recovery rules remain necessary.

`npm run worker:once` still performs at most one queue read and one job, even
when the concurrency setting is 16. It waits for that job's acknowledgement
before closing resources. An empty read reports empty and exits.

## Run locally

Restart existing workers to use the new runner. PowerShell:

```powershell
$env:WORKER_CONCURRENCY = '4'
$env:ALLOW_LOOPBACK_ENDPOINTS = 'true'
npm run worker
```

Linux:

```sh
WORKER_CONCURRENCY=4 ALLOW_LOOPBACK_ENDPOINTS=true npm run worker
```

Use the existing signed receiver setup, optionally with
`/webhooks?mode=slow&delay_ms=1000`, and submit several matching events with
distinct ingestion idempotency keys. Run the dispatcher continuously. Several
jobs may be processing at once, while endpoint quotas still decide when each
attempt can start. Keep RECEIVER_SIGNING_SECRET aligned with the endpoint.
Use `WORKER_CONCURRENCY=1` for sequential job processing within a process.

Inspect committed active leases during the experiment:

```sql
SELECT lease_owner, count(*) FROM deliveries
WHERE status = 'processing' GROUP BY lease_owner;
```

That query observes processing leases, not every active runner slot: a slot may
be in admission, completion, or acknowledgement instead. An abandoned lease
also remains until recovery. There is no new metrics endpoint in this phase.

## Verification

Fast tests use controlled promises to hold jobs and queue reads without timing
sleeps. They check the slot cap, slot reuse, acknowledgement order, draining,
read/processing/ack failures, stopped reads, once mode, and strict configuration.

Integration tests use isolated PostgreSQL schemas, random Redis stream/key
prefixes, and a real signature-verifying HTTP receiver whose responses are
released by the test. They prove actual overlap up to two slots, reuse of those
slots, active-job draining, recovery of failed/unread work, shared quota under
concurrent processing, and one HTTP attempt for overlapping duplicate jobs.
These are correctness checks, not throughput or latency benchmarks.

A GitHub Actions workflow now runs type checks, tests, and build on repository changes; see [ci.md](ci.md).
