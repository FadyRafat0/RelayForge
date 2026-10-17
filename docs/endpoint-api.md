# Checkpoint 1D: endpoint registration and listing

## Updating and pausing endpoints

`PATCH /api/endpoints/:id` accepts any nonempty subset of the registration
fields: `name`, `url`, `event_types`, `enabled`, and `rate_limit_per_second`.
The same validation and URL normalization rules apply. Omitted fields retain
their values; explicit nulls and unknown properties are rejected. Responses are
200 with the public endpoint (no signing secret), 404 for a missing UUID, 400 for
invalid input, or a generic 500 if storage fails. Secrets cannot be changed here.

```powershell
$endpointUrl = 'http://127.0.0.1:3000/api/endpoints/YOUR-ENDPOINT-UUID'
Invoke-RestMethod $endpointUrl -Method Patch -ContentType application/json -Body '{"enabled":false}'
Invoke-RestMethod $endpointUrl -Method Patch -ContentType application/json -Body '{"enabled":true,"rate_limit_per_second":5}'
```

One parameterized UPDATE is atomic; concurrent patches of different fields do
not reset omitted values. Changes to the same field use last-write-wins semantics.
There is no optimistic version precondition for configuration updates.

Disabling excludes the endpoint from new event matching and future worker claims.
Already claimed HTTP requests can still finish; pending deliveries remain pending.
Re-enabling lets reconciliation republish pending work (possibly up to the
60-second stale-publication interval). Events accepted while disabled do not
gain retroactive deliveries when it is re-enabled. Editing URL or subscriptions
does not rewrite existing events/delivery rows; future claims of existing
deliveries use the current URL and limit. History is preserved rather than
deleting endpoints referenced by deliveries.

## Request flow

```text
HTTP request
    -> Fastify JSON Schema validation
    -> route handler: URL checks, normalization, defaults
    -> endpoint store: parameterized SQL through the existing pool
    -> PostgreSQL constraints and persistence
    -> JSON response
```

`src/endpoints/routes.ts` owns HTTP behavior. `src/endpoints/store.ts` owns SQL and converts PostgreSQL Date values into ISO timestamp strings. `src/database.ts` assembles the store with the existing connection pool. One insert is already atomic; an explicit multi-statement transaction is not needed for endpoint registration.

## Start locally

```powershell
npm run db:up
npm run db:migrate
npm run dev
```

Use a second terminal for the following requests.

## Register an endpoint

```powershell
$body = @{
    name = 'Payment receiver'
    url = 'https://example.com/webhooks'
    event_types = @('payment.succeeded')
} | ConvertTo-Json

Invoke-RestMethod -Method Post `
    -Uri 'http://127.0.0.1:3000/api/endpoints' `
    -ContentType 'application/json' -Body $body
```

Linux equivalent:

```sh
curl -i http://127.0.0.1:3000/api/endpoints \
  -H 'Content-Type: application/json' \
  -d '{"name":"Payment receiver","url":"https://example.com/webhooks","event_types":["payment.succeeded"]}'
```

Success returns HTTP **201 Created** with the saved row: id, name, url, event_types, enabled, rate_limit_per_second, created_at, updated_at, and signing_secret. Store the secret for receiver configuration now; it is returned only on creation with Cache-Control: no-store. IDs and timestamps come from PostgreSQL. Registering the same URL again creates another endpoint; URL uniqueness and registration idempotency are not part of this API.

| Field | Rule |
| --- | --- |
| name | Required string, 1–100 characters, not whitespace-only; outer whitespace is trimmed |
| url | Required HTTP(S) URL, at most 2048 characters; no whitespace, backslashes, embedded credentials, or nonempty fragments; normalized with URL parsing |
| event_types | Optional distinct array, 1–100 entries; each is `*` or a 1–100 character name starting with a letter/digit and continuing with letters, digits, dots, underscores, or hyphens |
| enabled | Optional boolean, defaults to true; false is preserved |
| rate_limit_per_second | Optional integer 1?1000, defaults to 10; shared refill rate and burst capacity for worker admission |

Omitted subscriptions default to `["*"]`, matching all event types during ingestion. Do not combine `*` with specific types. Unknown fields and incorrect types are rejected rather than silently removed or converted.

The API only saves registration. It does not contact the destination or prove that it is reachable. Local/private destinations can be registered, but the worker validates resolved addresses before sending, rejects non-public destinations by default, and does not follow redirects. The worker's explicit development flag permits loopback for the local receiver. This local single-project API has no authentication or project ownership yet.

## List endpoints

```powershell
Invoke-RestMethod 'http://127.0.0.1:3000/api/endpoints?limit=20&offset=0' |
    ConvertTo-Json -Depth 5
```

Success returns HTTP **200 OK**:

```json
{"endpoints":[],"limit":20,"offset":0}
```

The array contains saved endpoint objects without signing_secret. Enabled and disabled endpoints are both included. Rows are ordered newest first by creation time, then UUID descending to break timestamp ties.

- `limit`: default 20, range 1–100.
- `offset`: default 0, range 0–999999.
- Parameters must be decimal digit strings, without signs, whitespace, or unnecessary leading zeroes.
- An empty database or an offset beyond its rows returns an empty array.

Offset pagination is deliberately simple. It is not a snapshot: insertions between page requests can move rows between pages. Large offsets also become costly. We can introduce cursor pagination later if needed.

## Parameterized SQL

The store sends SQL and values separately:

```ts
sql.query(
  'INSERT INTO webhook_endpoints (name, url, event_types, enabled) VALUES ($1, $2, $3, $4)',
  [input.name, input.url, input.event_types, input.enabled],
);
```

PostgreSQL treats each parameter as data. A name containing quotes or SQL-like text stays a name, rather than changing the query. Never concatenate user input into SQL strings. Column names and table names in these queries are fixed by our code.

## Errors and tests

Invalid request data returns 400 before the store is called. Unsupported content types can return 415. Store failures return a generic 500 response; details are logged by the server. `/health` continues to return 503 for failed connectivity checks. No failed insert is reported as 201.

`npm test` covers validation, defaults, pagination bounds, HTTP response shape, and hidden error details with a fake store. `npm run test:integration` uses isolated PostgreSQL schemas to verify actual persistence across app instances, explicit subscriptions/disabled state, SQL-like names, ordered pagination, and absence of writes for invalid input. Application rows are not modified by these tests.

References: [Fastify validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/), [node-postgres parameterized queries](https://node-postgres.com/features/queries).


Worker admission uses this endpoint policy through a shared Redis token bucket; see [rate-limits.md](rate-limits.md). Denials defer delivery without creating an HTTP attempt.
