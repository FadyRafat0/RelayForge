# HTTP worker (introduced in 3B, retries in 3C, durable leases in 4A)

## The full path

```text
API -> PostgreSQL event + deliveries -> dispatcher -> Redis Stream
                                                        |
                                                  consumer group
                                                        |
                                                      worker
                                                        |
                                           HTTP POST to the receiver
                                                        |
                                          commit attempt + delivery result
                                                        |
                                                   Redis XACK
```

The worker now handles a bounded number of jobs at a time (WORKER_CONCURRENCY, default 4). One queue reader feeds free slots, and acknowledgements use a separate connection; see worker-concurrency.md. Separate processes share a Redis consumer group; committed PostgreSQL leases and ownership tokens protect logical deliveries when duplicate jobs exist.

## Try a local delivery

Terminal 1:

```powershell
npm run services:up
npm run db:migrate
npm run dev
```

Terminal 2 (register first, then configure the receiver with its secret):

```powershell
$endpointBody = @{
    name = 'Local receiver'
    url = 'http://127.0.0.1:8080/webhooks'
    event_types = @('demo.created')
} | ConvertTo-Json
$endpoint = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/api/endpoints' `
    -ContentType 'application/json' -Body $endpointBody
$env:RECEIVER_SIGNING_SECRET = $endpoint.signing_secret
npm run receiver
```

This starts a verifying teaching receiver with durable receipt/effect transactions in PostgreSQL. Migration 005 must be applied. The receiver ID defaults to local-demo and must remain stable across restarts. It runs at http://127.0.0.1:8080/webhooks.
It logs accepted delivery IDs and returns 200 by default. Query options simulate
failures and delays; see retries.md. Secrets are returned only on creation and
are omitted from listings. See signatures.md for provisioning and wire details.

Terminal 3:

```powershell
$eventBody = @{
    type = 'demo.created'
    payload = @{ message = 'Hello from RelayForge' }
    idempotency_key = [guid]::NewGuid().ToString()
} | ConvertTo-Json -Depth 10
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/api/events' `
    -ContentType 'application/json' -Body $eventBody

npm run dispatch:once
$env:ALLOW_LOOPBACK_ENDPOINTS = 'true'
npm run worker:once
```

The worker's local-development option allows loopback addresses, not arbitrary private-network destinations. It defaults to false. For Linux use `ALLOW_LOOPBACK_ENDPOINTS=true npm run worker:once`.

One-shot mode handles one stream job; an older backlog or a duplicate can be encountered before your new job. Run it again as needed. For ongoing processing, run `npm run dispatcher` and `npm run worker` in separate terminals. Enable loopback in the worker terminal for the local receiver. Ctrl+C stops new work and drains active jobs before closing connections; a waiting queue read blocks for at most one second, and an HTTP send has a five-second deadline. Infrastructure errors exit the process with nonzero status; restart it after restoring the service.

## Consumer group vocabulary

- **Stream entry:** one queue publication, identified by its Redis stream ID.
- **Group:** a shared record of work assigned to workers. Our group is relayforge-workers.
- **Consumer:** one worker identity, randomly generated on startup.
- **XREADGROUP:** assigns a new entry to a consumer and puts it in the group's pending list.
- **XACK:** removes an entry from the pending list after its database outcome is committed. It does not delete the entry from the stream.
- **XAUTOCLAIM:** transfers entries idle for at least 60 seconds to a replacement consumer. The worker checks these before reading new entries.

The group starts at stream position 0, so entries published before the first worker are included. A Redis pending entry is different from a PostgreSQL pending delivery: Redis tracks acknowledgement of one job publication; PostgreSQL tracks the underlying delivery's lifecycle.

## What the worker does

1. Validate the delivery UUID from the job. Malformed jobs are acknowledged without database work. Before claiming, the CLI checks eligibility and shared endpoint quota. Denied jobs get a durable later due time without an attempt; see rate-limits.md.
2. Begin a PostgreSQL transaction and select this specific due pending delivery with FOR UPDATE. Waiting briefly for a publishing dispatcher avoids acknowledging a delivery merely because its row is still locked. Dispatcher batch scans use SKIP LOCKED to select other available work; a specific queued ID must not use that shortcut.
3. Skip missing, completed, future-scheduled, disabled, locked, or actively leased deliveries. Skipped jobs are acknowledged; durable work remains available for dispatch or lease recovery.
4. Insert an in-progress attempt, increment attempt_count, and commit a 30-second lease. Release the connection.
5. Send an HTTP POST without holding a database connection or lock.
6. In a new short transaction, verify the ownership token and expiry, then record the result and clear the lease.
7. Acknowledge Redis only after that commit.

Processing state and in-progress history are now committed and visible during HTTP. The dispatcher recovers expired claims, preserving abandoned history and the consumed attempt budget. A late worker cannot overwrite a replacement's result. See worker-leases.md for the full protocol.

## HTTP contract

The JSON body is an event envelope:

```text
{ id: <event UUID>, type: <event type>, payload: <original JSON>, created_at: <ISO timestamp> }
```

Headers include Content-Type: application/json, X-RelayForge-Delivery-Id, X-RelayForge-Event-Id, and X-RelayForge-Attempt. Delivery/event IDs stay stable across retries; the attempt number increases after committed attempts. X-RelayForge-Signature authenticates the timestamp, delivery ID, attempt number, and exact JSON body bytes using HMAC-SHA256. The receiver requires its endpoint secret and accepts timestamps within five minutes; see signatures.md.

The sender accepts HTTP(S), validates all resolved IP addresses, and connects directly to a selected validated IP while preserving the original Host and TLS certificate hostname checks. There is no second DNS lookup for the connection. Loopback, private, link-local, multicast, reserved, and unsupported transition ranges are blocked by default. The development flag permits loopback only. HTTP redirects and protocol upgrades are not followed. DNS waiting, connection setup, and response reading share a five-second deadline. Response bodies are discarded, capped at 64 KiB, and not stored.

## Result states and retry policy

| Result | Attempt | Delivery |
| --- | --- | --- |
| HTTP 2xx | succeeded, HTTP status recorded | succeeded, completion time set |
| Retryable HTTP response, timeout, or network error; budget remains | failed | pending, scheduled with exponential backoff/jitter |
| Permanent failure or exhausted attempt budget | failed | dead, completion time set |

Retries clear queue markers, and the dispatcher queues the delivery once its due time arrives. The current policy distinguishes permanent/transient failures, applies equal jitter, and honors Retry-After on 429/503. See retries.md for precise rules and limits. Dead rows stop being dispatched. Inspection and audited manual replay are now available through /api/deliveries routes; see dead-deliveries.md.

If an endpoint is disabled after queueing, the worker skips sending without consuming an attempt. The obligation remains pending for possible re-enablement; the dispatcher can still republish it periodically. An endpoint setting change does not cancel an HTTP request that already started.

## Crash and acknowledgement behavior

If the claim transaction fails, its changes roll back and Redis is not acknowledged. If completion fails after a committed claim, the durable lease and in-progress attempt remain; database recovery marks expired claims abandoned and schedules retries. XAUTOCLAIM can reclaim idle stream jobs independently. Restart workers to recreate a missing group after stream loss. The dispatcher must run (or leases:recover must be invoked) to recover expired processing state.

An HTTP side effect cannot be rolled back. If the receiver processes a request and the worker dies before saving its result, another worker may send it again. Its interrupted attempt is now preserved as abandoned and consumes budget. The receiver CLI now uses these stable delivery IDs to deduplicate its example SQL effect in PostgreSQL; see receiver-deduplication.md. This remains at-least-once delivery, not exactly-once processing.

If the database commit succeeds but XACK fails, reclaiming that job skips its already completed delivery and acknowledges it without sending again. The stream is not trimmed yet; retention policy is future work.

## Inspect the result

```sh
docker compose exec redis redis-cli XPENDING relayforge:deliveries relayforge-workers
docker compose exec postgres psql -U relayforge -d relayforge
```

Inside psql:

```sql
SELECT id, status, attempt_count, next_attempt_at, completed_at FROM deliveries ORDER BY created_at DESC LIMIT 10;
SELECT delivery_id, attempt_number, outcome, http_status, error_message FROM delivery_attempts ORDER BY started_at DESC LIMIT 10;
\q
```

## Files and verification

- src/queue/redis.ts: consumer group creation, read, reclaim, acknowledgement.
- src/worker/process.ts: claim, HTTP, retry decision, and completion orchestration.
- src/worker/claims.ts, completion.ts, recovery.ts: durable lease lifecycle and crash recovery.
- src/worker/http.ts: bounded HTTP sender and destination policy.
- src/worker/consume.ts: process-before-ack ordering and malformed jobs.
- src/worker.ts: worker process and shutdown.
- src/receiver.ts: local receiver example.

Tests use ephemeral loopback HTTP servers, isolated PostgreSQL schemas, and random Redis streams. They cover delivery, retry history, exhaustion, timeouts, duplicate jobs under active leases, terminal duplicate skipping, disabled endpoints, destination restrictions, malformed jobs, acknowledgement order, and reclaim after a forced database completion failure. Additional lease tests terminate a dedicated child worker and verify crash recovery, retained history, connection release, and stale-worker fencing.

References: [Redis consumer groups](https://redis.io/docs/latest/commands/xreadgroup/), [XACK](https://redis.io/docs/latest/commands/xack/), [Redis Streams recovery](https://redis.io/docs/latest/develop/data-types/streams/), [Node HTTPS](https://nodejs.org/api/https.html).


## Correlated outcome logs (checkpoint 6A)

Worker records now include delivery/event/endpoint and attempt IDs when available. delivery.processed reports the saved outcome and observed HTTP duration; worker.job_acknowledged separately confirms Redis XACK. LOG_LEVEL controls Pino output, with claim details at debug. See [observability.md](observability.md) for fields and the PostgreSQL-backed /metrics route.
