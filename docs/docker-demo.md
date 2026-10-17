# Complete Docker demo

Docker packages the compiled application and its Node runtime into an image.
Compose starts separate processes from that image plus PostgreSQL and Redis.
The processes have separate memory and lifecycles; they communicate over a
Docker network. Named volumes preserve database and Redis files across restarts.
Long-running services use Docker's `unless-stopped` restart policy; provisioning
is one-shot. Application container logs rotate at 10 MB with three files retained.
Restart policies recover process exits, while database leases recover unfinished
delivery ownership. A passing health check alone does not prove worker progress.

```sh
npm run demo:up
```

Only Docker with Linux containers and Compose is required for this command;
`docker compose -f compose.demo.yaml up -d --build --wait` is equivalent without npm.
The API is at http://127.0.0.1:3100. The ordinary development configuration
(`compose.yaml`) remains separate and keeps its existing volumes and ports.

The build uses two stages: the first installs dependencies and compiles TypeScript;
the final image contains compiled JavaScript, production dependencies, and SQL
migrations. It runs as the unprivileged `node` user. `.dockerignore` allows only
the required source/build inputs into the build context, excluding `.env`, Git,
test artifacts, and local dependency directories.

Startup order is deliberate:

1. PostgreSQL and Redis pass their health checks.
2. A one-shot provisioner applies checksum-verified migrations and creates the
   demo endpoint if absent. Repeated starts preserve its secret and your edits.
3. The API, receiver, and dispatcher start; the worker waits for the receiver.

The receiver loads the demo endpoint's randomly generated secret from PostgreSQL
using the explicit `DEMO_RECEIVER_ENDPOINT_ID` setting. This avoids a hardcoded
signing key. It is a local-demo convenience: an independent receiver normally
gets the registration secret out of band and uses `RECEIVER_SIGNING_SECRET`.
Receiver-owned example tables share the database here, but have no dependency
on sender transaction commits for processing received HTTP requests.

The demo worker uses `network_mode: service:receiver`. Both processes therefore
see the same network interfaces and loopback address, while retaining separate
filesystems and processes. The receiver still listens only on `127.0.0.1:8080`;
its port is not published. The worker explicitly enables loopback destinations.
Private-network and link-local destinations remain blocked by the HTTP sender.
This is a local simulator arrangement, not the networking layout for independent
customers. Recreate workers along with a recreated receiver; Compose's dependency
restart setting handles explicit receiver updates in this stack.

Send an event from PowerShell:

```powershell
$body = @{ type = 'demo.event'; payload = @{ message = 'Hello RelayForge' } } | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:3100/api/events -Method Post -ContentType application/json -Body $body
Invoke-RestMethod http://127.0.0.1:3100/health
docker compose -f compose.demo.yaml logs --tail 20 worker receiver
```

Or from Linux:

```sh
curl -fsS http://127.0.0.1:3100/api/events -H 'Content-Type: application/json' \
  -d '{"type":"demo.event","payload":{"message":"Hello RelayForge"}}'
curl -fsS http://127.0.0.1:3100/metrics
```

The preconfigured endpoint subscribes only to `demo.event` and `benchmark.event`,
with a rate limit of 1000/s so it does not hide dispatcher throughput in load tests.
Normal API registrations still default to 10/s.

To simulate two failures followed by success for each new delivery:

```powershell
$url = 'http://127.0.0.1:3100/api/endpoints/00000000-0000-4000-8000-000000000001'
Invoke-RestMethod $url -Method Patch -ContentType application/json -Body '{"url":"http://127.0.0.1:8080/webhooks?mode=flaky&failures=2"}'
```

Submit another event and watch the attempt history/logs. Change the URL back to
`http://127.0.0.1:8080/webhooks` to restore success mode. Use `enabled: false` to
pause new matching deliveries and future claims; existing in-flight requests may
still finish. Re-enable to resume existing pending work through reconciliation.

```sh
docker compose -f compose.demo.yaml up -d --scale worker=2
npm run demo:stop
npm run demo:up
npm run demo:down
```

Scaling adds processes to the same consumer group; each has its own bounded
concurrency and shares endpoint token buckets. `demo:stop` stops containers;
`demo:down` removes containers/network but keeps data volumes. Neither deletes
your database. Set `DEMO_PORT` in the shell if port 3100 is occupied. The demo API
has no authentication and binds to host loopback; keep it local.

See [Docker Compose networking](https://docs.docker.com/compose/how-tos/networking/)
for service discovery and network modes.
