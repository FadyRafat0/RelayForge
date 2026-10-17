# Checkpoint 4B: signed webhook delivery

HMAC lets a receiver check that a request was produced by someone holding its
endpoint secret and that its signed contents were not changed. Both sides hold
the same secret. It is a keyed hash, not encryption or a public-key signature.

## Request path

```text
Register endpoint -> PostgreSQL generates secret -> API returns it once
                                                 -> configure receiver
Worker claims delivery -> reads endpoint secret -> serializes JSON once
  -> signs metadata + raw bytes -> sends HTTP -> receiver verifies -> processes
```

Migration 004 adds `webhook_endpoints.signing_secret`. Its default concatenates
two cryptographically random UUIDs (244 random bits) under a `whsec_` prefix.
Every existing endpoint receives a distinct secret during migration. A NOT NULL
constraint and format check protect the column. No new table or Redis field is
needed: Redis still carries only delivery IDs.

`POST /api/endpoints` returns `signing_secret` with `Cache-Control: no-store`.
Store it when registering; `GET /api/endpoints` deliberately omits it. RelayForge
retains the secret in PostgreSQL because signing needs the original value; a
password-style one-way hash would not work. Encryption at rest, secret rotation,
and authenticated secret provisioning remain future work. This remains a local
learning application without API authentication.

## Exact wire format

```http
X-RelayForge-Delivery-Id: <delivery UUID>
X-RelayForge-Attempt: 1
X-RelayForge-Signature: t=<Unix seconds>,v1=<64 lowercase hex characters>
```

```text
signed bytes = UTF8(timestamp + "." + deliveryId + "." + attemptNumber + ".")
               followed by the exact HTTP request body bytes
v1 = HMAC-SHA256(key = complete secret as UTF8, message = signed bytes)
```

The complete `whsec_...` string is the key; do not hex-decode its suffix.
The worker builds one Buffer and uses that same Buffer for signing and sending.
JSON parsing followed by serialization can change whitespace or key order;
receivers must verify the raw bytes before parsing or performing side effects.
The event ID is in the signed JSON body. Its extra convenience header is not
independently signed; use the verified body's event ID for trusted decisions.

Verification validates header syntax, UUID and attempt metadata, rejects
timestamps more than 300 seconds in either direction, computes the expected
MAC, and compares equal-length buffers with `timingSafeEqual`. Keep deployed
clocks synchronized. Each retry uses the same delivery ID and a new attempt
number, with a timestamp generated when sending that attempt.

Wrong secrets, altered bodies/metadata, missing signatures, malformed/duplicate
signature fields, and expired signatures receive a generic 401 before receiver
counters or logs are updated. Under the existing retry policy, 401 is permanent
and the delivery becomes dead. Correct receiver provisioning matters.

## Local setup

Start the services and API using the README instructions. In another PowerShell
terminal, register the receiver and start it with the returned secret:

```powershell
$endpoint = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/api/endpoints' `
  -ContentType 'application/json' -Body (@{
    name = 'Signed local receiver'
    url = 'http://127.0.0.1:8080/webhooks'
    event_types = @('demo.signed')
  } | ConvertTo-Json)
$env:RECEIVER_SIGNING_SECRET = $endpoint.signing_secret
npm run receiver
```

Submit a `demo.signed` event from a third terminal, then run the dispatcher and
worker with `ALLOW_LOOPBACK_ENDPOINTS=true` as shown in [worker.md](worker.md).
Do not print or commit real secrets. On Linux, set
`export RECEIVER_SIGNING_SECRET='<secret returned on registration>'` in the
receiver terminal. The process exits on missing or malformed configuration.

The receiver accepts one endpoint secret per process. For a different endpoint,
restart it with that endpoint's secret; multiple destinations need separate
receiver instances or a future key-routing design. Existing endpoint secrets
are backfilled in the database but have no retrieval API. For a local demo,
disable an old endpoint through SQL and register a fresh one, avoiding duplicate
subscriptions. Stop and restart API/workers around migration 004.

## Limits and verification

Signatures authenticate contents; HTTPS is still needed to keep contents and
headers confidential. A captured valid request can be replayed inside the
five-minute window. The receiver CLI now uses a durable inbox to deduplicate
completed deliveries; see [receiver-deduplication.md](receiver-deduplication.md).
The chaos counter itself is an in-memory simulator and does not provide deduplication.
Its test factory has an explicit `allowUnsigned` option for chaos-only tests;
the receiver CLI always requires a secret.

Fast tests cover independent HMAC construction, raw UTF8 bytes, whitespace
changes, wrong keys, metadata changes, malformed headers, and freshness bounds.
HTTP tests connect the actual sender to the verifying receiver. Integration
tests exercise API-issued secrets through PostgreSQL, Redis, signed retries,
and success, and verify per-row migration backfill and omission from listings.

References: [Node crypto HMAC and timingSafeEqual](https://nodejs.org/api/crypto.html),
[PostgreSQL UUID functions](https://www.postgresql.org/docs/current/functions-uuid.html),
[Stripe raw-body verification guidance](https://docs.stripe.com/webhooks/signature).
