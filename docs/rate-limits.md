# Checkpoint 5A: shared per-endpoint rate limits

Ten workers must not each get their own ten-request allowance for one endpoint.
They need shared admission state. PostgreSQL holds the endpoint's policy; Redis
coordinates the short-lived quota used by every worker.

Migration 007 adds `webhook_endpoints.rate_limit_per_second`, default 10, with a
database check from 1 to 1000. Registration accepts an optional integer with
that name; registration and listing return the saved value. Existing endpoints
receive the default without changing their IDs or signing secrets.

## Token bucket

The rate is both the refill per second and the bucket's capacity. With a rate
of 2, an idle endpoint can admit a burst of two attempts, then one more every
500 ms while busy. This is a burst-friendly admission limit, not a strict cap
of two requests in every possible rolling one-second interval.

```text
tokens = min(capacity, previous_tokens + elapsed_ms * rate / 1000)
if tokens >= 1: subtract one and allow
otherwise: deny and calculate milliseconds until one token is available
```

The Redis key is `relayforge:rate-limit:<endpoint UUID>`. Its hash contains
`tokens` (possibly fractional) and `updated_at` (milliseconds). Separate endpoint
registrations have separate quotas even when their URLs share a host or are
identical. There is no per-host or account-wide quota yet.

A short Lua script reads Redis TIME, refills, consumes, and sets a two-second
expiry in one atomic operation. Worker clocks do not supply quota time. Separate
GET/SET commands would let concurrent workers read the same remaining token
and both spend it. Atomic execution prevents that race; see
[Redis scripting](https://redis.io/docs/latest/develop/programmability/eval-intro/).

Idle buckets can expire safely because the full refill takes one second. Busy
buckets refresh their expiry on each check. The script clamps backward clock
movement rather than using negative elapsed time. Large server clock changes
or Redis data loss can still alter admission behavior; this is not durable
financial accounting. Redis restart/data loss may restore a fresh burst.

## Worker path

```text
Read due pending delivery + endpoint policy -> release PostgreSQL connection
                         |
                 Redis token decision
                  /              \
               allow             deny
                 |                |
       claim attempt + lease   persist later next_attempt_at
       commit, send HTTP       clear queue markers, commit
       save result             no attempt and no lease
                  \              /
                     Redis XACK
```

All worker CLI sends use the limiter. The testable `processDelivery` function
accepts it as an injected dependency; older focused retry/lease tests can omit
it. There is a separate Redis connection for admission so a blocking stream
read does not delay limiter commands. Redis operations have a two-second
deadline and offline command queuing is disabled.

Eligibility is checked first: completed, disabled, leased, future-scheduled,
or exhausted deliveries do not consult the limiter. An allowed delivery then
goes through the existing claim transaction, which checks eligibility again.
No database connection is held while Redis responds or while HTTP is in flight.

A denied delivery remains pending. Its due time becomes the database's current
time plus Redis's relative delay; queue markers are cleared so the dispatcher
can publish it when due. No HTTP request, attempt record, budget increment, or
lease is created. Workers return `rate_limited` and move on without sleeping.
The dispatcher currently polls every second in bounded batches, so actual
delivery can be later than the calculated token time. A rate limit is an upper
bound on admission, not a throughput promise or an exact scheduling guarantee.

The conditional delay update checks pending state, the observed attempt count,
and that the delivery is still due. If another worker claimed it or scheduled
real retry backoff, the stale admission operation returns skipped instead of
overwriting that newer state. A failure to persist the delay leaves the Redis
job unacknowledged.

## Failure and concurrency tradeoffs

If Redis is unavailable, returns an invalid decision, or times out, the worker
does not send. The delivery remains pending without a new attempt, and its
stream job remains unacknowledged. The CLI exits on infrastructure failures;
restart it after recovery. Existing dispatcher reconciliation and stream
reclaim handle durable pending work. Event ingestion and PostgreSQL health
checks remain independent of Redis availability.

PostgreSQL and Redis do not share a transaction. A permission can be spent even
if the worker loses the claim race, crashes before claiming, or times out after
Redis applied the command. We do not refund ambiguous permissions. This can
temporarily reduce throughput, but avoids creating extra tokens by mistake.
Deleting limiter keys or bypassing the CLI's admission path bypasses this
policy. Admission also limits neither concurrent in-flight requests nor exact
arrival/completion times at the receiver; worker scheduling and network delays
can change when an admitted request reaches it.

Every retry and manual replay requests admission again. A rate-limit denial
does not consume their attempt budgets. Receiver HTTP 429/503 Retry-After still
controls only the affected delivery's retry schedule; it does not change this
endpoint-wide quota or pause all its other deliveries. Runtime SQL policy
changes affect subsequent checks and clamp retained tokens to the new capacity;
they do not revoke already issued permissions.

## Local exercise

Stop old workers, apply migration 007, and restart the API and workers:

```powershell
npm run db:migrate
# In the API terminal: npm run dev
```

Register the receiver with a small rate (then configure its returned secret as
shown in signatures.md):

```powershell
$endpoint = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:3000/api/endpoints' `
  -ContentType 'application/json' -Body (@{
    name = 'Limited local receiver'
    url = 'http://127.0.0.1:8080/webhooks'
    event_types = @('demo.limited')
    rate_limit_per_second = 1
  } | ConvertTo-Json)
$env:RECEIVER_SIGNING_SECRET = $endpoint.signing_secret
npm run receiver
```

In another terminal, submit several `demo.limited` events with distinct
idempotency keys, run the dispatcher continuously, and start two worker
terminals with `ALLOW_LOOPBACK_ENDPOINTS=true`. Both workers share the same
endpoint quota. Look for `rate_limited` outcomes; denied deliveries retain their
attempt count and later become eligible again. This is a learning experiment,
not a measured benchmark.

For an existing endpoint, update the policy through the management API:

```powershell
Invoke-RestMethod "http://127.0.0.1:3000/api/endpoints/$endpointId" -Method Patch `
  -ContentType 'application/json' -Body '{"rate_limit_per_second":1}'
```

## Files and tests

- `src/worker/rate-limit.ts`: Redis connection, atomic token bucket, response validation.
- `src/worker/admission.ts`: eligibility read and conditional durable deferral.
- `src/worker/process.ts`: admission before claim/HTTP.
- `src/worker.ts`: always wires shared admission into the worker CLI.
- `test/integration/rate-limits.test.ts`: shared clients, refill/capacity, endpoint isolation, database connection release, and races.

Tests seed only their own bucket timestamps to exercise refill and concurrency
without sleeping. They use random key prefixes and isolated database schemas;
they never flush Redis or change other limiter keys. Queue tests confirm that
denials are acknowledged after persistence, while limiter and database failures
remain unacknowledged. Endpoint API and migration tests cover validation,
persistence, constraints, and backfill.

Bounded worker concurrency is now implemented, while shared limits and leases remain in force; see [worker-concurrency.md](worker-concurrency.md).
