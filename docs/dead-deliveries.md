# Checkpoint 4D: inspect and replay dead deliveries

A delivery becomes `dead` when a failure is permanent or its attempt budget is
exhausted. It remains in PostgreSQL, including its attempt history. This is our
durable dead-letter store; we do not need another Redis queue to retain failures.
The dispatcher only publishes pending work, so dead deliveries stay stopped
until someone investigates and explicitly replays them.

## API contracts

| Request | Result |
| --- | --- |
| GET /api/deliveries/dead?limit=20&offset=0 | Dead deliveries, newest completion first with UUID as a tie-breaker |
| GET /api/deliveries/:id | Delivery state, event type, endpoint enabled flag, latest attempt, and latest replay audit |
| GET /api/deliveries/:id/attempts?limit=20&offset=0 | Attempt history, highest attempt number first |
| POST /api/deliveries/:id/replay | Atomically reopen a dead delivery and save a reason/budget audit row |

Lists return `{ deliveries, limit, offset }` or `{ attempts, limit, offset }`.
Pagination defaults to 20/0, limits pages to 100 rows, and caps offset at 999999.
Malformed UUIDs, unknown list query fields, and invalid bodies return 400;
unknown delivery IDs return 404. Details wrap the result in `{ delivery }`.
Inspection excludes event payloads and endpoint signing secrets. Successful
responses use `Cache-Control: no-store` so changing delivery state is not cached.
Offset pages can move when another delivery changes state; this is an operator
view, not a stable export snapshot.

Replay body:

```json
{
  "expected_attempt_count": 5,
  "additional_attempts": 2,
  "reason": "Receiver configuration corrected"
}
```

`expected_attempt_count` is required and must match the count you inspected.
`reason` is required, trimmed, and limited to 200 characters. `additional_attempts`
defaults to 5 and must be an integer from 1 to 10. Extra fields and numeric strings
are rejected. This local single-project API still has no authentication; operator
authorization and audit actor identity must be added before external exposure.

## Preserve identity and history

Replay keeps the event ID, delivery ID, endpoint ID, payload, and all attempt
records. It does not create a new event or recalculate subscriptions.

```text
Before: dead, attempt_count=5, max_attempts=5
Replay with additional_attempts=2
After:  pending, attempt_count=5, max_attempts=7
Next worker attempts: 6, then 7 if the retry policy allows
```

The budget is always `attempt_count + additional_attempts`, even if the previous
delivery stopped early. For example, count 1 / old maximum 5 plus two attempts
becomes maximum 3. Unused old budget is replaced. Permanent failures can still
stop after one attempt, and repeated transient failures stop at the new maximum.
Backoff continues to use lifetime attempt numbers; replay does not reset it.
Integer overflow is rejected as a conflict.

Stable delivery identity is essential: if the receiver committed its action but
the worker failed before saving success, a replay uses that same ID and the
receiver inbox acknowledges the duplicate without repeating its SQL effect.
Creating a new delivery ID would bypass that protection.

## Transaction and concurrency

Replay runs in one short PostgreSQL transaction:

1. Lock the delivery for update and its endpoint for share.
2. Require dead state, matching expected count, and an enabled endpoint.
3. Insert a `delivery_replays` row containing the reason, previous count/budget,
   additional attempts, UUID, and timestamp.
4. Set pending, replace the budget, clear completion and queue markers, and make
   the delivery due now.
5. Commit before returning 202 with `{ delivery, replay }`.

The endpoint share lock keeps its enabled flag stable during this transaction.
The audit row and state change either both commit or both roll back. A unique
`(delivery_id, previous_attempt_count)` key also protects replay generations.
The existing worker claim, lease, and completion rules remain in force.

Two concurrent replay requests cannot both reopen the same failure. The first
commits; the next sees pending and receives 409. A delayed request from an older
dead generation also receives 409 even if a later attempt has already failed
again. Pending, processing, succeeded, disabled-endpoint, and stale-count cases
all return 409.

This uses an expected-version check, not an idempotency-key success cache. If the
response is lost, inspect the delivery and latest replay before deciding whether
to issue another request. Repeating the same request can return 409.

Redis is not called by replay. HTTP 202 means the work was durably reopened,
not delivered. The dispatcher publishes it once Redis is available, and the
worker signs and sends it normally. Old stream entries carry the same delivery
ID; database state and leases still arbitrate them.

## Try inspection and replay

Apply migration 006 with `npm run db:migrate`, restart the API, and use PowerShell:

```powershell
Invoke-RestMethod 'http://127.0.0.1:3000/api/deliveries/dead?limit=10' |
  ConvertTo-Json -Depth 6

$deliveryId = '<delivery UUID you want to investigate>'
$inspection = Invoke-RestMethod "http://127.0.0.1:3000/api/deliveries/$deliveryId"
$inspection | ConvertTo-Json -Depth 8
Invoke-RestMethod "http://127.0.0.1:3000/api/deliveries/$deliveryId/attempts?limit=20" |
  ConvertTo-Json -Depth 6
```

Fix the underlying cause before replaying. For a local exercise, register an
endpoint at `/webhooks?mode=status&status=400` and follow worker.md to deliver an
event. It becomes dead after its first attempt and the receiver saves no effect.
Change that endpoint's URL through the management API using the inspected UUID:

```powershell
$endpointId = $inspection.delivery.endpoint_id
Invoke-RestMethod "http://127.0.0.1:3000/api/endpoints/$endpointId" -Method Patch `
  -ContentType 'application/json' -Body '{"url":"http://127.0.0.1:8080/webhooks"}'
```

Keep the receiver running with that endpoint's signing secret. Then:

```powershell
$replayBody = @{
  expected_attempt_count = $inspection.delivery.attempt_count
  additional_attempts = 2
  reason = 'Local receiver failure mode corrected'
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3000/api/deliveries/$deliveryId/replay" `
  -ContentType 'application/json' -Body $replayBody
npm run dispatch:once
$env:ALLOW_LOOPBACK_ENDPOINTS = 'true'
npm run worker:once
```

Inspect again: the same delivery should succeed with the next attempt number.
One-shot workers may encounter older jobs first; run again as needed.

Full replay audit history is retained in SQL; the detail API shows its latest row:

```sql
SELECT id, delivery_id, reason, previous_attempt_count, previous_max_attempts,
       additional_attempts, replayed_at
FROM delivery_replays ORDER BY replayed_at DESC, id DESC LIMIT 20;
```

## Verification and next step

Tests cover validation, pagination, latest-failure inspection, exact extra
budgets, unchanged event identity, concurrent and stale requests, disabled
endpoints, integer overflow, and rollback on either write failing. Real
PostgreSQL/Redis/HTTP tests repair a receiver then replay successfully, and
manually replay an exhausted interrupted delivery whose receiver effect was
already committed. That replay creates no second effect.

Shared per-endpoint rate limits now apply to replayed work too; see rate-limits.md. Replay remains manual and
one delivery at a time; no automatic bulk replay or background replay loop is
introduced in this phase.
