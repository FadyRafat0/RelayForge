# Checkpoint 3C: backoff, jitter, and a chaos receiver

## Why change the retry policy?

A fixed retry delay can make many failed deliveries wake up together and overload an already struggling receiver. Backoff increases the wait as failures continue. Jitter randomizes the scheduled time so deliveries spread out.

For failed attempt number n, our policy uses:

```text
window = min(5 minutes, 5 seconds * 2^(n - 1))
delay  = random value in [window / 2, window)
```

This is equal jitter. The first retry is scheduled 2.5–5 seconds after failure; the second 5–10 seconds; the third 10–20 seconds. The window caps at five minutes. With the default five-attempt budget, at most four retries are scheduled. A larger budget can reach the cap.

`next_attempt_at` is stored in PostgreSQL. The worker does not sleep during the backoff period and does not hold a database connection during that wait. It commits the failed attempt and schedule, acknowledges the current stream job, and can process other work. The dispatcher publishes the delivery when due. Polling and queue load can make an actual retry later than its due time; it must not run earlier.

The worker now commits a durable lease before HTTP and releases its database connection. Expired claims are recovered using this same backoff policy; see worker-leases.md.

## Which failures get retried?

| Outcome | Decision |
| --- | --- |
| HTTP 2xx | Succeeded |
| HTTP 408, 425, 429 | Retry while attempts remain |
| HTTP 5xx except 501 and 505 | Retry while attempts remain |
| Other HTTP responses, including redirects and most 4xx | Dead after this attempt |
| Timeout, connection reset, DNS/network error | Retry while attempts remain |
| Blocked destination, unsupported URL/protocol upgrade, oversized response, known certificate-validation errors | Dead after this attempt |
| Retryable failure on the last allowed attempt | Dead |

This is an explicit RelayForge policy, not a universal property of every HTTP service. For example, a 404 is usually a wrong endpoint URL; sending it repeatedly is unlikely to fix it. We can make classifications configurable later if a real integration needs different behavior.

Failed attempt error_message now includes a decision reason such as permanent_http_response, permanent_request_error, transient_failure, attempt_limit_reached, or retry_after_exceeds_24h. Dead deliveries remain inspectable in PostgreSQL. Dead-delivery inspection and bounded manual replay are now available; see dead-deliveries.md.

## Retry-After

For HTTP **429 and 503**, the sender reads Retry-After and the policy accepts either:

```http
Retry-After: 60
Retry-After: Thu, 01 Jan 2026 00:01:00 GMT
```

The first form is a nonnegative integer number of seconds. The second is an HTTP date. Dates use the worker's clock; synchronized clocks matter in a deployed system.

The scheduled delay is the larger of jittered backoff and the server's requested minimum. A short or past hint cannot force an immediate retry. Malformed hints are ignored and backoff is used. Hints beyond our 24-hour scheduling limit stop the delivery with retry_after_exceeds_24h, rather than retrying sooner than requested. This is separate from the five-minute exponential window cap.

Retry-After is applied to this delivery, not every delivery targeting the same endpoint. A shared per-endpoint token bucket now limits admissions independently; it does not turn Retry-After into an endpoint-wide cooldown. See rate-limits.md.

## The chaos receiver

Register the endpoint and set RECEIVER_SIGNING_SECRET from the registration response before starting `npm run receiver` (see signatures.md). Choose behavior in the registered endpoint URL:

| URL path | Behavior |
| --- | --- |
| /webhooks | Return 200 |
| /webhooks?mode=flaky&failures=2 | Return 500 twice, then 200, per delivery ID |
| /webhooks?mode=status&status=404 | Return the chosen 400–599 status |
| /webhooks?mode=rate-limit&retry_after=7 | Return 429 with Retry-After: 7 |
| /webhooks?mode=status&status=503&retry_after=7 | Return 503 with the same hint |
| /webhooks?mode=slow&delay_ms=6000 | Delay the response, exceeding the worker's normal five-second timeout |
| /webhooks?mode=timeout | Read the request but never respond; the worker must time out |

The base URL is http://127.0.0.1:8080. The simulator accepts failure counts 0–100, delays 0–10000 ms, and numeric Retry-After values 0–999999 seconds. Invalid options return 400. The large Retry-After range allows testing the worker's 24-hour stop rule.

The CLI now saves successful deliveries in a durable PostgreSQL inbox; see receiver-deduplication.md. Completed duplicates return 200 without another effect. Slow mode commits before delaying its reply; timeout mode applies no new effect.

Chaos call counters are in memory and keyed by X-RelayForge-Delivery-Id. They reset when the receiver restarts and track at most 10000 IDs, evicting the oldest tracked ID when needed. Logs show the mode, delivery ID, call number, and selected status without logging full payloads. This is a local teaching simulator, not a production receiver or benchmark.

## Try failure and recovery yourself

Start services/API as in worker.md. Register this destination with subscription demo.flaky, then start the receiver using that registration's signing_secret:

```text
http://127.0.0.1:8080/webhooks?mode=flaky&failures=2
```

Submit an event with type demo.flaky and a new idempotency key. Run the dispatcher continuously in one terminal and, in another:

```powershell
$env:ALLOW_LOOPBACK_ENDPOINTS = 'true'
npm run worker
```

Watch the receiver log 500, 500, 200 with the same delivery ID. The worker logs retry_scheduled, retry_scheduled, succeeded. Inspect history with:

```sql
SELECT d.id, d.status, d.attempt_count, d.next_attempt_at,
       a.attempt_number, a.http_status, a.error_message
FROM deliveries d JOIN delivery_attempts a ON a.delivery_id = d.id
ORDER BY a.started_at DESC LIMIT 20;
```

For rate-limit and permanent-error experiments, register separate destinations subscribed to distinct event types so each test is easy to inspect. Restart the receiver with the corresponding secret for each experiment; one receiver process verifies one endpoint secret. Registering another endpoint does not change an already accepted event's delivery set; submit a new logical event with a new key.

## Files and tests

- src/worker/retry.ts: pure policy, equal jitter, Retry-After parsing, and failure classification.
- src/worker/http.ts: status/Retry-After response metadata and typed permanent request errors.
- src/worker/process.ts: persist the selected retry schedule and decision reason.
- src/receiver/app.ts: testable simulator factory.
- src/receiver.ts: local process entry point.

No migration is needed: next_attempt_at and attempt history already exist. Unit tests inject a deterministic random source to verify exact window growth and caps. Integration tests verify persisted delays, actual headers, permanent stopping, and recovery against the chaos receiver using real PostgreSQL/Redis. Tests advance only their isolated delivery's due time instead of sleeping through retries; this verifies scheduling and outcomes without claiming real-time latency measurements.

References: [HTTP Retry-After](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after), [AWS discussion of backoff and jitter](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/retry-backoff.html).
