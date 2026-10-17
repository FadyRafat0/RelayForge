# Checkpoint 5C: GitHub Actions CI

Continuous integration runs the project's checks on a fresh machine whenever
code changes. It catches problems hidden by local state: an untracked file,
an outdated dependency installation, missing environment settings, or SQL that
cannot initialize an empty database.

The workflow lives in `.github/workflows/ci.yml`. GitHub recognizes workflows
in this directory after they are committed and pushed to a GitHub repository
with Actions enabled. There is no deployment step in this phase.

## The workflow vocabulary

| Term | Meaning in RelayForge |
| --- | --- |
| Workflow | The complete CI definition in ci.yml |
| Event | A push, pull request update, or manual workflow dispatch |
| Job | One fresh Ubuntu 24.04 runner executing our checks |
| Step | A named command or reusable action within that job |
| Service | A temporary PostgreSQL or Redis container available to that job |
| Check result | The commit's pass/fail status after the job finishes |

One job keeps the first version easy to follow. It has a 15-minute timeout.
New runs cancel older in-progress runs for the same branch or pull request.
Different branches and pull requests have separate concurrency groups.

## What runs

1. Check out the source, with persisted Git credentials disabled.
2. Read Node's version from `.nvmrc` and restore npm's download cache.
3. Run `npm ci`, installing the exact dependency versions in package-lock.json.
4. Copy `.env.example` to `.env` on the disposable runner.
5. Type-check source and tests, then run fast tests.
6. Apply all migrations to a fresh PostgreSQL database.
7. Run integration tests with real PostgreSQL, Redis, and local HTTP receivers.
8. Build the TypeScript application into dist/.

Steps stop on failure, so a red type check prevents later steps from running.
The workflow token only has repository read permission. Checkout and setup-node
are pinned to full commit hashes, with release versions in comments. Updating
those pins is an explicit maintenance change.

The npm cache stores downloaded package data, not node_modules or database
state. `npm ci` still installs from the lockfile on every run and fails if the
manifest and lockfile disagree. Updating package.json requires updating and
committing package-lock.json too.

## Service setup and environment

GitHub starts `postgres:18-alpine` and `redis:8-alpine`, matching our local major
versions. Health checks wait for both services before steps begin. Each run
gets fresh service data without our local Docker volumes.

Commands run directly on the Ubuntu runner, so the mapped service ports are
reachable at 127.0.0.1:5432 and 127.0.0.1:6379. The job supplies its own
DATABASE_URL and REDIS_URL. Those environment variables override the local
example values loaded by Node's `--env-file=.env` scripts.

The PostgreSQL user, password, and database in the workflow are public,
disposable test settings; no GitHub secrets are required. Tests can create
their isolated schemas, and Redis tests use random keys. Service availability
is required: integration tests fail instead of silently skipping checks.

## Read a failed run

After pushing the repository, open GitHub's Actions tab, choose CI, and open
the `Typecheck, tests and build` job. Expand the first failed step:

| Failed step | First things to inspect |
| --- | --- |
| Install locked dependencies | Lockfile agreement, Node version, registry access |
| Check TypeScript | Compiler error, file, and line shown in the log |
| Run fast tests | Failed assertion and the intended API or worker behavior |
| Apply migrations | SQL errors or a mismatch in already applied migration history |
| Run integration tests | Service startup, database/Redis errors, and the failed scenario |
| Build | Production compilation and module paths |

Fix the cause and push another commit; the new run checks it again. To make a
passing CI check a condition of merging, configure a required status check in
the repository's merge rules after the first hosted run. The workflow itself
does not change repository merge settings.

## Local verification

With the existing `.env` configured as in README.md, the relevant commands are:

```sh
npm ci
npm run services:up
npm run typecheck
npm test
npm run db:migrate
npm run test:integration
npm run build
```

The completed workflow was checked with actionlint 1.7.12. Its commands were also run on
Node 24 in a Linux container with fresh, isolated PostgreSQL 18 and Redis 8
containers: installation, type checking, 298 fast tests, all seven migrations,
145 integration tests, and the build passed. That local Linux validation does
not execute GitHub's checkout/setup/cache machinery or constitute a hosted
Actions run. The first hosted result is available after pushing to GitHub.

To lint a workflow locally from PowerShell with Docker:

```powershell
$ciRepoPath = (Get-Location).Path
docker run --rm --mount "type=bind,source=$ciRepoPath,target=/repo,readonly" `
  --workdir /repo rhysd/actionlint:1.7.12 .github/workflows/ci.yml
```

CI checks correctness for the covered scenarios. It does not establish measured
throughput or production reliability; load tests and observability are still
separate learning phases.

References: [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax),
[PostgreSQL services](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers),
[Redis services](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-redis-service-containers),
[setup-node](https://github.com/actions/setup-node),
[actionlint](https://github.com/rhysd/actionlint).

Structured logs and delivery metrics are now implemented; see [observability.md](observability.md).

The final workflow also runs `npm run benchmark -- --rate 2 --seconds 2 --output ci-smoke.json`.
This provisions the complete isolated Docker stack, posts four events through
k6, verifies four successful deliveries and durable receiver effects, then removes
that project's containers and volumes. It exercises the built production image,
startup ordering, provisioning, signatures, database/Redis communication, and
receiver network configuration. Its thresholds are smoke checks, not benchmark
claims about hosted CI hardware. Full measured runs are described in
[load-testing.md](load-testing.md).
