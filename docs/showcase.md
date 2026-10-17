# Static project showcase

The `showcase/` directory is a standalone HTML/CSS/JavaScript site. It needs no
Node server, database, API keys, or paid backend hosting when published. GitHub
Pages hosts it separately from the actual delivery application.

The site clearly identifies itself as a recorded demonstration. Selecting a
scenario inspects actual captured attempts. Playing a trace reveals that stored
history at four times its recorded speed; it does not issue webhook requests.
Architecture exploration links directly to the implementation. Benchmarks are
copied without rounding from the repository's measured JSON reports and checked
against those originals by tests.

## Preview

```sh
npm run showcase
```

Open http://127.0.0.1:4173/RelayForge/. This preview also exercises the repository
subpath used by GitHub Pages. Stop with Ctrl+C.

## Refresh recorded evidence

```sh
npm run showcase:record
npm test
```

The recording script provisions a unique disposable Compose project. It records
successful delivery and keyed ingestion deduplication, two 500 failures followed
by success, a permanent 400 failure, and a repaired dead delivery with audited
replay. It checks outcome, attempt count and receiver effect count before saving
`showcase/traces.json`. Only attempt/status/timestamp/audit metadata is exported;
signing secrets, connection URLs, and event payloads are excluded.

For recording only, endpoints use the isolated receiver's demo signing key so
one verifier can process all four scenarios. This happens inside the temporary
recording database. The script never reads or resets your development database.
It removes only its own project and volumes. A forced process termination may
require manual cleanup of the exact printed project name.

## Publish free with GitHub Pages

1. Push the showcase and `.github/workflows/pages.yml` to the repository's `main` branch.
2. In the GitHub repository, open **Settings → Pages → Build and deployment**.
3. Set **Source** to **GitHub Actions**.
4. Open **Actions → Publish showcase → Run workflow** if the initial push ran before Pages was enabled.
5. Use the URL reported by the successful deployment. The standard URL for this
   repository is `https://fadyrafat0.github.io/RelayForge/`.

The workflow uploads only `showcase/`; it does not upload `.env`, the backend,
database files, or local tooling. It uses immutable action SHAs and the minimal
Pages deployment permissions. Future changes under `showcase/` deploy on pushes
to `main`. Never describe the expected URL as live until deployment succeeds.

GitHub Pages is available for public repositories on GitHub Free. See
[GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
and [custom workflow configuration](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Browser verification and screenshots

Browser tooling is kept outside application dependencies:

```powershell
npm install --prefix .tools --no-package-lock --no-audit --no-fund playwright@1.64.1
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD\.tools\browsers"
node .tools/node_modules/playwright/cli.js install chromium
npm run showcase
```

In another terminal, with the same browser path set:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "$PWD\.tools\browsers"
node scripts/check-showcase.mjs
```

The browser script checks scenario selection, recorded playback, the Docker
instructions modal, component details, benchmark values, mobile overflow, and
an unavailable-recording error state. It captures real desktop/mobile screenshots
under `docs/screenshots/`. `.tools/` is ignored by Git. On Linux, set
`PLAYWRIGHT_BROWSERS_PATH` with `export` instead; the Node scripts are shared.
