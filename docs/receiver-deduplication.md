# Checkpoint 4C: durable receiver deduplication

Consider a receiver that credits an account:

```text
Receiver commits credit -> worker crashes before saving success
                        -> replacement worker sends the same delivery again
```

The second request can have a valid signature. Signing answers who sent the
request and whether its contents changed. Deduplication answers whether this
delivery's business action has already committed.

## Two receiver-owned tables

Migration 005 adds these tables to our existing local PostgreSQL database:

| Table | Purpose |
| --- | --- |
| receiver_receipts | Remembers a completed delivery's receiver ID, delivery UUID, raw-body SHA256 hash, and receipt timestamp |
| receiver_effects | Example business effect: the received JSON object and application timestamp |

The primary key `(receiver_id, delivery_id)` identifies a delivery within a
logical receiver. The effects table has a foreign key to the receipt with the
same key. Neither table references the sender's events or deliveries: an actual
customer receiver would own its own database. Sharing one database instance is
only a local demonstration convenience.

`RECEIVER_ID` defaults to `local-demo`. Keep it stable across restarts and secret
rotation; give separate logical receivers different IDs. The ID accepts 1–100
characters: a leading letter/digit followed by letters, digits, dots, underscores,
or hyphens. It is a deduplication namespace, not authentication. This demo still
verifies one endpoint secret per receiver process.

## The atomic transaction

For a valid signed JSON object in a successful receiver mode:

```sql
BEGIN;
INSERT INTO receiver_receipts (...)
VALUES (...)
ON CONFLICT (receiver_id, delivery_id) DO NOTHING
RETURNING delivery_id;
-- If inserted: INSERT INTO receiver_effects (...) VALUES (...);
-- Otherwise: SELECT body_sha256 FROM receiver_receipts WHERE ...;
COMMIT;
-- Only now send HTTP 200.
```

If the receipt was inserted, the same transaction saves the example effect.
If saving the effect fails, PostgreSQL rolls back the receipt too and the HTTP
handler returns a generic 503. A retry can then perform the action.

If a receipt already exists with the same raw-body hash, the receiver returns
200 with `duplicate: true` without writing another effect. A different body
under the same delivery ID returns 409. Even a whitespace-only change counts as
a different body; RelayForge sends the same serialized event across retries.
The timestamp and attempt number are not part of this body hash, so a fresh
signature and incremented attempt number still match the original receipt.

The unique key also handles concurrency: competing inserts wait for the
winning transaction to finish. We use a separate SELECT statement after
`ON CONFLICT DO NOTHING`, because READ COMMITTED gives each statement a fresh
snapshot. Putting both into one statement can miss a concurrently committed
receipt. See [PostgreSQL's isolation documentation](https://www.postgresql.org/docs/current/transaction-iso.html).

## Failure behavior

| Situation | Outcome |
| --- | --- |
| First successful request | Receipt and effect commit together, then 200 |
| Same delivery retried concurrently or after restart | 200, duplicate true, no additional effect |
| Same ID with different signed JSON bytes | 409, original effect retained |
| Missing, incorrect, or expired signature | 401 before accessing the inbox |
| Signed body is invalid JSON or not an object | 400, no effect |
| Database/effect failure | 503, transaction rolls back, worker can retry |
| Commit succeeds but HTTP reply is lost | Retry finds the receipt and returns 200 |
| New delivery in flaky/status/rate-limit/timeout failure mode | No receipt or effect saved |

Completed duplicates return 200 even if a chaos failure mode is selected later.
`slow` mode commits the effect before delaying its reply; it can demonstrate
lost acknowledgements. `timeout` mode never applies a new effect. The simulator's
in-memory call counters still reset on restart, but durable receipts do not.
Counters and console logs are diagnostics, not the business effect.

## Run and inspect

Stop the receiver before migrating, then run:

```powershell
npm run db:migrate
# Register an endpoint and set its secret as shown in signatures.md.
$env:RECEIVER_ID = 'local-demo'
npm run receiver
```

The CLI now requires PostgreSQL and migration 005 as well as its signing secret.
It uses `DATABASE_URL` from `.env`. The testable chaos factory only enables
durable deduplication when an inbox is supplied; the CLI always supplies one.

After a delivery, inspect the receiver-owned data:

```sh
docker compose exec postgres psql -U relayforge -d relayforge
```

```sql
SELECT receiver_id, delivery_id, received_at FROM receiver_receipts;
SELECT receiver_id, delivery_id, event, applied_at FROM receiver_effects;
```

Tests reproduce the ambiguous sender outcome by allowing the receiver to
commit, forcing the worker's completion transaction to fail, recovering the
expired lease, and delivering again. Two HTTP attempts produce one receiver
effect. Other tests send concurrent duplicates, roll back failed effects,
and restart the receiver and connection pool after losing an HTTP reply.

## Guarantees and limits

Delivery remains at least once. This example ensures at most one committed SQL
effect per receiver/delivery key while receipts are retained. An event sent to
two endpoints creates two delivery IDs; those are separate obligations. Event
ingestion idempotency, signature freshness, and receiver deduplication solve
different problems.

A network call, email, or payment cannot participate in this PostgreSQL
transaction. For such effects, use an external idempotency key or a receiver
outbox and its own delivery policy. Do not claim exactly-once external effects.
All code paths performing the protected SQL action must follow the inbox
transaction; direct manual writes can bypass this application-level rule.

There is no cleanup policy yet. Deleting receipts or changing RECEIVER_ID allows
old deliveries to be processed again. A future retention policy must account
for retry and manual replay horizons. Receiver data survives process restarts
through PostgreSQL; durability still depends on database storage and backups.

Dead-delivery inspection and manual replay now preserve these same delivery IDs; see [dead-deliveries.md](dead-deliveries.md).
