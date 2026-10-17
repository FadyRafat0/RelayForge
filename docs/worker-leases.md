# Checkpoint 4A: durable worker leases

## What changed?

The first worker kept a PostgreSQL transaction and row lock open during HTTP. It was simple, but occupied a database connection while waiting and lost its uncommitted attempt history on a crash.

The worker now separates processing into three stages:

```text
Short transaction: claim delivery + create attempt -> COMMIT -> release connection
                                 |
                        bounded HTTP request
                                 |
Short transaction: verify lease + save result     -> COMMIT -> Redis XACK
```

The default lease lasts 30 seconds; the normal HTTP deadline is five seconds. There is no heartbeat/lease renewal yet because sends are bounded. If longer tasks are introduced, lease duration and renewal must be revisited.

## The database fields

Migration 003_worker_leases.sql adds:

- `active_attempt_id`: the UUID of the currently owning attempt. Each new attempt gets a different token.
- `lease_expires_at`: expiry time according to PostgreSQL's clock.
- `lease_owner`: the worker's identity for inspection.
- A partial index on processing deliveries by lease expiry, supporting recovery scans.
- `abandoned` as an attempt outcome, representing an expired claim with unknown HTTP outcome.

Constraints require processing deliveries to have all lease fields, and other states to have none. A composite foreign key requires the active attempt to belong to that same delivery. The supporting unique index is in addition to the attempt primary key.

Stop old worker/dispatcher processes before upgrading, then run `npm run db:migrate` and restart them. The migration preserves any legacy in-progress attempt as abandoned and returns interrupted legacy processing deliveries to pending, or dead if their budget is exhausted. Already finished attempts remain unchanged.

## Claim

The worker briefly locks a due pending delivery, checks its budget and enabled endpoint, inserts an in-progress attempt, increments attempt_count, and stores the lease fields. All of that commits together. Only then does it send HTTP.

Other sessions can now see the processing delivery and in-progress attempt during the request. Another worker sees an active claim and skips a duplicate job. The database connection and row lock have already been released, so even a pool with one connection can serve other database work during HTTP.

A committed claim consumes one attempt, even if the worker stops before it actually sends. This keeps repeated crashes from bypassing the attempt budget. It also means attempt_count counts allocated attempts, not a perfectly known number of receiver-side effects.

## Completion and fencing

The worker locks the delivery briefly and verifies that it is still processing under its own active_attempt_id. In a fresh statement after locking, it checks lease_expires_at against clock_timestamp() before updating. Attempt and delivery results commit atomically.

If ownership changed, the lease expired, or the delivery already finished, the worker returns `lost_lease` without changing the database. The associated Redis job can be acknowledged because durable database recovery is responsible for the obligation.

Why check a token as well as a timestamp? An old worker can resume after a pause while a replacement worker owns the delivery. Its old token cannot overwrite or clear the replacement's claim, even if the delivery ID is the same. These UUIDs provide an equality-based ownership check in PostgreSQL; they are not increasing sequence numbers or a fence enforced by the receiver.

Expiry is checked using the database clock, avoiding disagreement between workers' host clocks for lease decisions. A validated completion transaction holds its row lock until commit, so recovery cannot replace ownership halfway through that transaction.

## Recovery

The dispatcher now runs a bounded expired-lease recovery pass before each dispatch batch. Recovery uses FOR UPDATE SKIP LOCKED so multiple recovery processes can work safely.

For each expired claim it:

1. Marks the owning in-progress attempt `abandoned`, with a finish time and `HTTP outcome unknown` message.
2. Keeps the consumed attempt count.
3. Clears ownership and queue markers.
4. Schedules a pending retry using the existing backoff/jitter policy, or marks the delivery dead if its budget is exhausted.

The dispatcher publishes it once the new due time arrives. Recovery itself does not send HTTP or append to Redis. An expired lease is eligibility for recovery, not an automatic retry exactly at 30 seconds: polling, backoff, and backlog add time.

An operator can run one PostgreSQL-only recovery batch independently:

```powershell
npm run leases:recover
```

It prints the recovered count, up to ten per invocation. Running it again is safe; recovered claims no longer match. The continuous dispatcher handles subsequent batches automatically. Recovery must be running for expired processing deliveries to progress; Redis XAUTOCLAIM alone does not reset database leases.

Redis and database recovery have different jobs. XAUTOCLAIM reassigns an idle stream entry after 60 seconds; the database recovery pass handles expired 30-second delivery leases. Lost stream entries are still recoverable by dispatching durable pending deliveries after the lease is reset. Restart workers to recreate a missing Redis group after stream loss.

## What a crash leaves behind

| Failure | Durable state |
| --- | --- |
| Before claim transaction commits | Claim/attempt roll back; delivery remains pending |
| After claim commits, before/during HTTP | Processing delivery and in-progress attempt remain until recovery |
| HTTP completes, but result transaction fails | Same durable claim remains; HTTP outcome is unknown to recovery |
| Result commits, then Redis acknowledgement fails | Final state remains; reclaimed duplicate skips completed work |
| Old worker returns after replacement claim | Old completion is rejected; replacement state/history is preserved |

Lease recovery cannot undo an HTTP side effect. A paused old worker can also resume sending after its lease expires. Ownership checks protect PostgreSQL, not the receiver. Stable delivery IDs and receiver-side idempotency are still needed for at-least-once delivery. We do not claim exactly-once execution.

## Inspect a running system

```sql
SELECT id, status, attempt_count, active_attempt_id, lease_owner, lease_expires_at
FROM deliveries ORDER BY created_at DESC LIMIT 20;

SELECT delivery_id, attempt_number, outcome, started_at, finished_at, error_message
FROM delivery_attempts ORDER BY started_at DESC LIMIT 20;
```

For a visible in-progress example, register the chaos receiver with `mode=slow&delay_ms=4000`, submit a new event, and watch those queries while the worker runs. The request is below the normal five-second HTTP deadline, but long enough to inspect the committed claim. Normal test commands do not deliberately terminate your running worker processes.

## Code and verification

- src/db/transaction.ts: shared same-connection transaction helper, rollback, and release.
- src/worker/claims.ts: claim persistence and lease creation.
- src/worker/completion.ts: ownership/expiry check and atomic result persistence.
- src/worker/recovery.ts: bounded abandoned-attempt recovery.
- src/worker/process.ts: claim, HTTP, decision, completion orchestration.
- src/recover-leases.ts: operator recovery command.

Tests verify connection release with a one-connection pool, visible in-progress state, claim rollback, expired/live leases, budget exhaustion, token fencing before and after a replacement finishes, concurrent recovery, cross-delivery ownership constraints, and legacy schema upgrade. One integration test starts its own child worker, waits for a committed claim, abruptly terminates that child, and verifies abandoned-attempt history followed by successful attempt two. Tests advance isolated lease/schedule timestamps rather than waiting through real recovery intervals. A separate compiled-code smoke check completes a local HTTP delivery after recovery.

References: [PostgreSQL row locking](https://www.postgresql.org/docs/18/sql-select.html), [conditional UPDATE](https://www.postgresql.org/docs/18/sql-update.html), [node-postgres transactions](https://node-postgres.com/features/transactions).
