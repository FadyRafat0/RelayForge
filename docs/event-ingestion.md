# Checkpoint 2B: event ingestion with idempotent retries

## What we built

`POST /api/events` saves an event and creates one pending delivery for each matching enabled endpoint. An optional idempotency_key lets client retries reuse that event without creating deliveries again. The unique database constraint already exists, so idempotency needed no new migration. Ingestion does not contact Redis or the receiver; the separate dispatcher publishes delivery IDs and the worker sends HTTP requests after commit.

```text
POST /api/events
    -> validate JSON body
    -> acquire one database connection
    -> BEGIN
    -> INSERT event ON CONFLICT (idempotency_key) DO NOTHING
    -> new event: INSERT deliveries by selecting matching endpoints
    -> existing key: compare original type/payload; replay or reject
    -> COMMIT
    -> release connection
    -> 201 Created (new) / 200 OK (replay)
```

If a statement fails before commit, the transaction rolls back. If rollback itself fails, the connection is discarded rather than reused in an unknown state.

## Try it

Start PostgreSQL and the API:

```powershell
npm run db:up
npm run db:migrate
npm run dev
```

In a second terminal, register a subscriber (see also the endpoint API guide):

```powershell
$endpointBody = @{
    name = 'Payment receiver'
    url = 'https://example.com/webhooks'
    event_types = @('payment.succeeded')
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/api/endpoints' `
    -ContentType 'application/json' -Body $endpointBody

$eventBody = @{
    type = 'payment.succeeded'
    payload = @{ payment_id = 'payment-123'; amount = 100; currency = 'EUR' }
    idempotency_key = 'payment-123-succeeded-v1'
} | ConvertTo-Json -Depth 10

Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/api/events' `
    -ContentType 'application/json' -Body $eventBody | ConvertTo-Json -Depth 10
```

Linux event submission:

```sh
curl -i http://127.0.0.1:3000/api/events \
  -H 'Content-Type: application/json' \
  -d '{"type":"payment.succeeded","payload":{"payment_id":"payment-123","amount":100,"currency":"EUR"},"idempotency_key":"payment-123-succeeded-v1"}'
```

The first successful submission returns HTTP **201 Created** with this shape. Repeating it returns **200 OK** with the same event metadata and `replayed: true`:

```text
{
  "event": {
    "id": "<PostgreSQL-generated UUID>",
    "type": "payment.succeeded",
    "created_at": "<ISO timestamp>"
  },
  "delivery_count": <number of matching enabled endpoints>,
  "replayed": false
}
```

The initial count depends on your registered endpoints. Registration examples create a new endpoint each time. An event replay does not add newly registered endpoints to the original event's deliveries.

## Idempotency: safely repeating a request

Imagine the API commits your event, but the response is lost on the network. You do not know whether it was accepted. Retry with the same idempotency_key and identical event data; RelayForge returns the existing event instead of creating another one.

| Submission | Response | Database effect |
| --- | --- | --- |
| New key | 201, replayed false | New event and matching deliveries |
| Same key, same type/payload | 200, replayed true | Reuse original event; no delivery insert |
| Same key, different type/payload | 409 Conflict | Original event and deliveries unchanged |
| No key | 201, replayed false | New event on every successful submission |

Generate a key once per logical event and reuse it for retries. A new key means a new event, even when its content is identical. Keys are case-sensitive, are not trimmed, and currently have no automatic expiry. They are scoped to this single local project's entire events table; tenant-specific keys require project ownership later. Deleting an event manually removes its key protection. There is no deletion API yet.

Equality uses PostgreSQL jsonb comparison: object key order is irrelevant, nested values are compared, arrays retain order, and JSON types matter. This is comparison of parsed JSON values, not the original request bytes. The event type must also match exactly. Replays return the original event ID and timestamp and count its stored delivery obligations; they do not re-run subscriber matching.

### Why concurrent retries are safe

Checking for a key before inserting is insufficient: two API processes could both observe that it is missing. Instead, INSERT relies on PostgreSQL's unique constraint. ON CONFLICT DO NOTHING waits for a competing transaction as necessary; only one committed event can own the key.

If no row was inserted, a separate SELECT reads the existing event in a fresh Read Committed statement snapshot. This matters because a concurrent winner might not have been visible when the INSERT began. If the winner rolls back, the waiting INSERT can proceed as a new event instead. The key, event, and deliveries participate in the same transaction, so a failed initial submission does not consume the key.

This is ingestion deduplication, not exactly-once webhook processing. Workers can still send a delivery more than once after crashes; receiver-side deduplication will be a separate feature.

## Validation

- `type`: required, 1–100 characters. Starts with a letter or digit; remaining characters may also include dots, underscores, and hyphens. `*` is not an event type.
- `payload`: required JSON object. Nested objects, arrays, strings, numbers, booleans, and null values are allowed within it. The root payload cannot itself be an array, scalar, or null.
- `idempotency_key`: optional string, 1–200 ASCII letters/digits or `.`, `_`, `:`, `-`. Empty, null, whitespace, and other characters are rejected. The API uses the JSON field, not an Idempotency-Key header.
- Unknown top-level fields and wrong types are rejected.
- The full event request body is limited to 64 KiB. Oversized requests return 413; invalid schema or malformed JSON returns 400. Unsupported media types can return 415.
- Database/transaction errors return a generic 500; server logs contain the error details.
- Reusing a key with different event data returns 409 and does not expose the original payload.

There is no event retrieval API yet. Use SQL to inspect the stored payloads and deliveries.

## Subscription matching

An endpoint receives a delivery only when enabled and either:

1. Its event_types array contains the event type exactly (case-sensitive).
2. Its event_types array contains `*`.

The query uses `ANY(event_types)` to test membership. `INSERT ... SELECT` creates delivery rows from matching endpoint rows, rather than making one application/database round trip per endpoint. An endpoint matching both predicates still produces only one row.

Matching uses the endpoints visible to that INSERT statement under PostgreSQL's Read Committed isolation. It is not a reservation of endpoint settings forever. Endpoints added or changed after that selection do not retroactively change the existing event's delivery set.

No matching endpoints is valid: the event is stored and delivery_count is zero. Ingestion creates no attempts; the worker creates them when it sends a delivery.

## Why the transaction matters

Without a transaction, an event could be saved while delivery insertion fails. RelayForge would have accepted data without recording the work owed to subscribers.

`BEGIN` starts a group of changes. `COMMIT` makes those changes durable together. `ROLLBACK` discards uncommitted changes. Every statement must use the same checked-out client: separate pool.query calls could run on different connections.

The route awaits the store, and the store awaits COMMIT. This gives a successful HTTP response a concrete meaning: the event and delivery obligations are committed. It does not mean the destination processed anything.

A client timeout or lost connection during commit can leave the client unsure whether acceptance happened. Retry with the same key and data to recover the original event or create it if nothing committed. Requests without a key still create separate events. Delivery deduplication and worker crash recovery are separate later concerns.

## Code guide

- `src/events/routes.ts`: request/response schemas, 64 KiB limit, and HTTP responses.
- `src/events/store.ts`: one checked-out connection, transaction, event insert, matching delivery insert, and connection release.
- `src/database.ts`: builds the event store using the existing pool.

## Inspecting the result

```sh
docker compose exec postgres psql -U relayforge -d relayforge
```

Inside psql:

```sql
SELECT id, type, payload, created_at FROM events ORDER BY created_at DESC LIMIT 10;
SELECT event_id, endpoint_id, status, attempt_count FROM deliveries ORDER BY created_at DESC LIMIT 10;
SELECT count(*) FROM delivery_attempts;
\q
```

## Verification

Fast tests cover validation, payload preservation at the route boundary, size limits, delayed store completion, new/replayed/conflict responses, and generic errors. Real PostgreSQL tests verify payload persistence, enabled/exact/wildcard matching, zero matches, rollback on forced delivery failure, connection reuse, invalid-input isolation, and SQL-like payload content. Idempotency tests cover restart persistence, changed data, JSON object/array equality, different keys, retries after rollback, original subscriber sets, twelve simultaneous same-key submissions across two pools, and concurrent different-data conflicts.

The rollback test adds a deliberately failing constraint only in its temporary test schema. It verifies that no event or delivery survives, removes the constraint, and submits successfully using the same app. Tests do not modify application rows.

References: [node-postgres transactions](https://node-postgres.com/features/transactions), [PostgreSQL INSERT](https://www.postgresql.org/docs/18/sql-insert.html), [Read Committed isolation](https://www.postgresql.org/docs/18/transaction-iso.html), [JSON types](https://www.postgresql.org/docs/18/datatype-json.html).
