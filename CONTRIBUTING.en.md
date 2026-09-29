# Contributing

Development environment, checks, code conventions, and change procedures.

## Ground rules

- Open an issue before a large change.
- Write an ADR first (see [ADR process](#adr-process)) for a new dependency, a change to the process or deployment model, the node channel protocol, `NodeConfig` IR semantics, or the security baseline.
- Report security vulnerabilities privately as described in [SECURITY.en.md](SECURITY.en.md), not in a public issue.
- Pull requests that break the principles below are not merged ([ADR-0018](docs/adr/0018-trust-and-security-baseline.md), [ADR-0019](docs/adr/0019-open-core-and-commercial-products.md)).

| Principle | Requirement |
| --- | --- |
| Phone-home and licensing | No phone-home, no license-check code |
| Telemetry | Off by default; third-party dependency telemetry hard-disabled |
| Sensitive data | Private keys, DNS API credentials, and similar secrets are envelope-encrypted with `EDGEWEIR_MASTER_KEY` before they reach the database; SSH credentials are never stored |
| Node identity | The node channel terminates its own TLS; enrollment tokens are single-use and stored as SHA-256 only; every node RPC after enrollment uses mTLS |
| API credentials | `/api/v1` accepts only `x-api-key`; `/rpc` accepts only the session cookie plus the CSRF header |
| Audit | Management actions write the audit log |
| Product boundary | Customer portals, plans and billing, finance, and reselling do not enter core code behind license switches ([LICENSING.en.md](LICENSING.en.md)) |
| Tests | Checks are never made to pass by skipping, deleting, or weakening tests |
| Dependencies | Dependency APIs and versions are verified against official documentation before use |

## Development environment

| Tool | Version | Used for |
| --- | --- | --- |
| Node.js | 24.11 or later (`.nvmrc`: `24`) | All development commands |
| pnpm | 12 (`packageManager`: `pnpm@12.6.0`) | Workspace and scripts; `corepack enable` or `npm i -g pnpm@12` |
| Docker, Compose v2 | — | Local PostgreSQL (`compose.dev.yml`), end-to-end tests |
| Go | 1.27.1 | `helpers/certd`, `pnpm e2e` |
| buf | 1.73.0 | Installed with the dev dependencies (`@bufbuild/buf`); called by `pnpm lint` and `pnpm proto:*` |

End-to-end tests also need curl, jq, goreleaser v2, syft, cosign v3.1.3, a checkout of [edgeweir-node](https://github.com/marvinli001/edgeweir-node) next to this repository (or `EDGEWEIR_NODE_CONTEXT`), and network access to deb.debian.org and openresty.org. The Playwright steps need Chromium:

```bash
pnpm --filter @edgeweir/console exec playwright install chromium
```

## Local run

1. Install dependencies.

   ```bash
   pnpm install
   ```

2. Start local PostgreSQL 18. It listens on `127.0.0.1:5432` (change the port with `DEV_POSTGRES_PORT`); user, password, and database are all `edgeweir`.

   ```bash
   docker compose -f compose.dev.yml up -d
   ```

3. Create `.env` and set `EDGEWEIR_MASTER_KEY` to the output of `openssl rand`, unchanged. `DATABASE_URL` in `.env.example` matches `compose.dev.yml`.

   ```bash
   cp .env.example .env
   openssl rand -base64 32
   ```

4. Start the console.

   ```bash
   pnpm dev
   ```

   One process: `:3000` serves the UI and API (the front end uses Vite HMR), `:8443` serves the node channel. Server changes restart the whole process. Until setup completes, the startup log prints the setup token (`setupToken` field).

5. Verify.

   ```bash
   curl -s http://localhost:3000/healthz
   ```

   Expected output: `{"status":"ok","version":"dev"}`. Open <http://localhost:3000/setup> and enter the setup token to complete the setup wizard.

## Commands

| Command | Effect | When to run |
| --- | --- | --- |
| `pnpm lint` | Biome check and format verification, `buf lint proto` | Before every commit |
| `pnpm format` | Biome auto-fix (`biome check --write .`) | When `pnpm lint` reports formatting |
| `pnpm typecheck` | Generates Paraglide messages and the route tree, then type-checks the whole workspace | Before every commit |
| `pnpm test` | Vitest unit and integration tests; PostgreSQL is in-process PGlite, no Docker | Before every commit |
| `pnpm build` | Production build: Vite front end and single-file server | When build configuration or dependencies change |
| `pnpm proto:lint` | `buf lint proto` | When `proto/` changes |
| `pnpm proto:gen` | Generates TypeScript from `proto/` into `packages/proto` | When `proto/` changes |
| `pnpm db:generate` | Generates a SQL migration from changes in `packages/db/src/schema` (drizzle-kit) | When the schema changes |
| `pnpm e2e` | End-to-end tests (`scripts/e2e.sh`); see [End-to-end tests](#end-to-end-tests) | When the node channel, config compiler, install script, or UI flows change |

CI runs on pull requests and pushes to `master`: `pnpm lint`, no diff in `packages/proto` after `pnpm proto:gen`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `go vet` and `go test -race` for `helpers/certd`, the image build, and the end-to-end tests.

## Tests

| Level | Tool | Location |
| --- | --- | --- |
| Unit and integration | Vitest (PGlite) | `apps/console/test/server`, `apps/console/test/web`, `packages/*/test` |
| certd | `go test -race ./...` | `helpers/certd` |
| UI flows | Playwright | `apps/console/e2e`, driven by `scripts/e2e.sh` |
| End-to-end | `scripts/e2e.sh` and `scripts/e2e-*.mjs` | `compose.e2e.yml` |

Run a single Vitest file from `apps/console`:

```bash
pnpm exec vitest run test/server/docs.test.ts
```

Tests enforce these conventions:

| Convention | Test |
| --- | --- |
| Message keys and placeholders match; error codes, reason codes, and node error codes have messages; no hard-coded text in components | `apps/console/test/web/i18n.test.ts` |
| No skeletons, no `*Description` components, no color literals, no links to other sites, appica-ui import scope | `apps/console/test/web/ui-rules.test.ts` |
| shadcn preset `b2D0wqNxT`; a single ThemeProvider | `apps/console/test/web/ui-preset.test.ts` |
| Every contract procedure is in the console list or the admin 403 table | `apps/console/test/server/admin.test.ts` |
| `.env.example` lists every variable the console reads and compose interpolates | `apps/console/test/server/env-example.test.ts` |
| Third-party images pinned by digest, Actions by commit SHA | `apps/console/test/server/supply-chain-pins.test.ts` |
| The compose templates embedded in `deploy.sh` match the repository files byte for byte | `apps/console/test/server/deploy-script.test.ts` |
| Relative doc links resolve; the ADR index is complete; the `ARCHITECTURE.md` data model lists every migration and table | `apps/console/test/server/docs.test.ts` |
| Migrations have contiguous numbers, increasing timestamps, and one SQL file plus one snapshot each | `packages/db/test/migrations.test.ts` |

Every new API procedure has a Vitest case.

## End-to-end tests

1. Build and start the test stack (postgres, console, node, and test origins).

   ```bash
   docker compose -f compose.e2e.yml up -d --build
   ```

2. Run the tests. `--up` starts the stack first; `--down` removes the stack and its volumes afterwards; `--skip-ui` skips Playwright.

   ```bash
   pnpm e2e
   ```

3. Verify: the output ends with `E2E OK`.

The variables for a second, parallel stack (`COMPOSE_PROJECT_NAME`, `E2E_CONSOLE_PORT`, `E2E_NODE_PORT`, `E2E_TAG`, `E2E_SUBNET`, `E2E_ISOLATED_SUBNET`, `E2E_INSTALL_IMAGE`, `EDGEWEIR_NODE_CONTEXT`) are listed in [README end-to-end tests](README.en.md#end-to-end-tests).

## Commit conventions

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).

```text
<type>(<scope>): <subject>

<body>

<footer>
```

| type | Use |
| --- | --- |
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Formatting with no logic change |
| `refactor` | Restructuring that is neither a feature nor a fix |
| `perf` | Performance |
| `test` | New or changed tests |
| `build` | Build system, dependencies, Dockerfile |
| `ci` | CI configuration |
| `chore` | Other maintenance |
| `revert` | Reverts an earlier commit |

Scopes: `console`, `web`, `api`, `db`, `contract`, `compiler`, `proto`, `node-channel`, `certd`, `deploy`, `e2e`, `doc`. Omit the scope for changes that span several modules.

Examples:

```text
feat(deploy): add deploy.sh to install and upgrade 宝塔 / aaPanel compose deployments
fix(certd): renew without ARI replaces when the CA rejects the new order
feat(console)!: drop the public landing page from the open core
```

| Rule | Requirement |
| --- | --- |
| Granularity | One change per commit; each commit passes the checks on its own |
| Subject | Chinese or English; at most 72 characters; no trailing period |
| Breaking changes | `!` after the type or scope, and a `BREAKING CHANGE:` footer stating the impact and migration |
| DCO | `git commit -s` adds `Signed-off-by`, agreeing to the [Developer Certificate of Origin](https://developercertificate.org/); recommended |

## Code conventions

| Area | Convention |
| --- | --- |
| TypeScript lint and format | Biome (configured at the repository root); no ESLint or Prettier |
| TypeScript types | `strict`; avoid `any`; zod validates system boundaries (API input, environment variables, external data) |
| Go (`helpers/certd`) | `gofmt`; passes `go vet` |

## UI rules

Based on [ADR-0003](docs/adr/0003-ui-shadcn-preset.md).

| Area | Rule |
| --- | --- |
| Components | shadcn components live in `components/ui` and use the Base UI `render` prop, not `asChild`; one ThemeProvider for the app |
| States | Every page has loading, empty, and error states |
| Copy | Short and user-facing; no page subtitles; no description paragraphs in dialogs or cards; empty states are a title plus an action; only one-line safety notes (e.g., "Shown once"), rendered with `SafetyNote` |
| Loading | No skeletons or `animate-pulse`; `TopProgress` (2px top bar) covers route loads, fetches, and mutations; first loads render `LoadingState`; submit buttons show `Spinner` and are disabled; polling queries set `meta: { background: true }` |
| Colors | No color literals in TS/TSX; colors come from CSS tokens |
| External links | No links to other sites, except the allow list in `ui-rules.test.ts` |
| appica-ui | Only through `src/web/components/appica/` and `appica-bridge.css` (scoped tokens, one `@source` per component) |
| Motion | Entrances use `animate-enter` with a staggered `animationDelay`; reduced motion is respected |
| Page scope | No marketing pages in the open core (ADR-0019) |

## Internationalization

Based on [ADR-0004](docs/adr/0004-i18n-paraglide.md).

- Every UI string goes through a Paraglide message function. Message files: `apps/console/messages/zh-CN.json` (default locale) and `apps/console/messages/en.json`.
- Keys are snake_case and start with the page or feature, e.g., `nav_sites`, `cert_brotli_unavailable`.
- Both locales change together: same key set, same placeholders, no empty values.
- `src/web/routes` and `src/web/components` contain no Chinese literals and no English UI text, including `aria-*`, `title`, `alt`, and `placeholder`.
- The server does not build user-facing sentences: the API returns error codes and the UI translates them; unknown codes fall back to the server's English `message`.

## Error codes

1. Add the code to `errorDefs` in `packages/contract/src/errors.ts` with its HTTP status and `params`.
2. On the server, call `fail(CODE, message, data)` (`apps/console/src/server/lib/errors.ts`): `message` is the English fallback, `data` supplies the fields named in `params`.
3. Add the message to both message files, with placeholders matching `params`.

| Code table | Location | Message key |
| --- | --- | --- |
| API error codes `errorDefs` | `packages/contract/src/errors.ts` | `error_<lowercase code>` |
| Revision reasons `revisionReasonDefs` | `packages/contract/src/errors.ts` | `revision_reason_<code>` |
| Node error codes `nodeErrorDefs` | `packages/contract/src/node-errors.ts` | `node_error_<code>` |
| Node task outcomes `taskErrorDefs` | `packages/contract/src/node-errors.ts` | `task_error_<code>` |
| Prefetch failure reasons `prefetchFailureReasonDefs` | `packages/contract/src/node-errors.ts` | `task_error_reason_<code>` |

## API and server conventions

| Convention | Location |
| --- | --- |
| API changes start in the oRPC contract; the same procedure serves `/rpc` (UI) and `/api/v1` (OpenAPI) | `packages/contract` |
| Admin-area procedures use the `admin` guard; tenant procedures use `tenant` (refused while a required two-factor setup is missing); member management uses `orgManager` | `apps/console/src/server/rpc/base.ts` |
| A new procedure goes into the console list `CONSOLE_PROCEDURES` or the tenant-member 403 table | `apps/console/test/server/admin.test.ts` |
| Management actions call `recordAudit` inside the change's transaction to write `audit_log` | `apps/console/src/server/services/audit.ts` |
| better-auth's own endpoints are audited by hooks | `apps/console/src/server/lib/auth-audit.ts` |
| better-auth HTTP endpoints are allow-listed (`AUTH_HTTP_ROUTES`); every other path under `/api/auth` returns 404; the organization and admin plugins are called server side only (`auth.api.*`) | `apps/console/src/server/lib/auth.ts` |
| Client IPs come only from `resolveClientIp`: the TCP peer; forwarding headers only when the peer is in `EDGEWEIR_TRUSTED_PROXIES` | `apps/console/src/server/lib/client-ip.ts` |
| Envelopes are bound to their row: `masterKey.seal(value, { purpose: "<table>.<column>", recordId })` | `apps/console/src/server/lib/envelope.ts` |
| Special-purpose address ranges for origins (the node keeps the same list) | `packages/contract/src/addresses.ts` |

## Proto changes

`proto/` is the only contract between the console and edgeweir-node ([ADR-0008](docs/adr/0008-node-channel-connect-rpc-mtls.md)).

1. Edit the `.proto` files under `proto/`. Within the `edgeweir.node.v1` package, only backward-compatible additions; a breaking change needs a new `v2` package. `NodeConfig` follows the canonical-encoding constraints of [ADR-0011](docs/adr/0011-config-model-nodeconfig-ir.md): no `map` fields, fields declared in ascending field-number order.
2. Run the linter.

   ```bash
   pnpm proto:lint
   ```

3. Compare against the previous proto tag to confirm there is no breaking change.

   ```bash
   pnpm exec buf breaking proto --against '.git#tag=proto/vX.Y.Z,subdir=proto'
   ```

4. Generate TypeScript and commit the `proto/` change together with the generated code in `packages/proto`. CI checks that the generated code matches `proto/`.

   ```bash
   pnpm proto:gen
   ```

5. After the merge to `master`, a maintainer tags `proto/vX.Y.Z`: new fields or RPCs bump the minor version, comment-only changes bump the patch version.
6. In edgeweir-node, set `PROTO_TAG` in the `Makefile` to the new tag, regenerate the Go code, adapt the node, and commit `internal/gen/`.

   ```bash
   make proto
   ```

7. Release order: upgrade the console first, then the nodes. The console stays compatible with nodes on the previous proto version.

## Database schema changes

1. Edit `packages/db/src/schema`.
2. Generate the migration.

   ```bash
   pnpm db:generate
   ```

3. Commit the new SQL file and `meta/` snapshot in `packages/db/migrations` together with the schema change.
4. List the new migration file name and any new table names in the data model section of `ARCHITECTURE.md`.
5. Verify.

   ```bash
   pnpm test
   ```

The console runs database migrations at startup.

## Environment variables

1. Declare the variable in the schema in `apps/console/src/server/lib/env.ts` (zod validation and default).
2. Add it to `.env.example` with a comment stating its purpose and default. Variables interpolated by the compose files also go into `.env.example`.
3. Describe the variable in both language versions of the [environment variables](docs/reference/environment.en.md) reference.
4. Verify.

   ```bash
   pnpm test
   ```

Operator configuration belongs in **Admin → System**; environment variables keep only values needed before setup or at the infrastructure level. When a setting exists both in system settings and as an environment variable, precedence is: value saved in Admin, environment variable, default.

## Updating pinned images and actions

Third-party inputs are pinned by immutable references ([ADR-0017](docs/adr/0017-release-supply-chain.md)); `pnpm test` rejects unpinned references, and edgeweir-node runs the same check with `make pin-check`. Images built from this repository or edgeweir-node are referenced by tag.

| Input | Form | Location |
| --- | --- | --- |
| Third-party images | `tag@sha256:<multi-arch index digest>` | `Dockerfile` (`# syntax=` line and `ARG *_IMAGE`), `compose*.yml`, `scripts/e2e.sh` (`E2E_INSTALL_IMAGE` default), `deploy.sh` (`PG_IMAGE` and embedded templates) |
| GitHub Actions | `owner/action@<40-character commit SHA> # vX.Y.Z` | `.github/workflows/*.yml` |

1. Look up the image digest. The `Digest` in the output is the multi-arch index digest; do not use a single-platform digest.

   ```bash
   docker buildx imagetools inspect <image>:<tag>
   ```

2. Look up the commit for an action release. For an annotated tag, use the SHA on the line ending in `^{}`.

   ```bash
   git ls-remote --tags https://github.com/<owner>/<action>
   ```

3. Change the tag and digest (or the SHA and version comment) together.
4. After changing `compose.baota.yml` or `compose.baota-host.yml`, copy the full file into the embedded template in `deploy.sh`; keep `PG_IMAGE` in `deploy.sh` equal to the PostgreSQL image in `compose.baota.yml`.
5. Verify.

   ```bash
   pnpm test
   bash deploy.sh template bundled | diff - compose.baota.yml
   bash deploy.sh template host | diff - compose.baota-host.yml
   ```

After a base image update, run the Release workflow manually in Actions to rebuild the tip of `master`.

## Releases

| Artifact | Trigger | Version |
| --- | --- | --- |
| Console image `ghcr.io/marvinli001/edgeweir` | The Release workflow publishes each `master` commit whose CI passed; a manual Release run rebuilds only the tip of `master` | `<YYYYMMDD>-<first 7 characters of the commit>` (UTC commit date, `scripts/image-version.sh`); `latest` moves along while that commit is still the tip of `master` |
| Node | `v*` tags in edgeweir-node | `vX.Y.Z` |
| Proto | Tag set by a maintainer on `master` | `proto/vX.Y.Z` |

Version pinning, upgrades, and rollback: [Versions, upgrades, and rollback](docs/deploy/upgrade.en.md). Artifact signatures and verification: [SECURITY.en.md](SECURITY.en.md).

## ADR process

1. Copy [docs/adr/template.md](docs/adr/template.md) to `docs/adr/NNNN-slug.md`. `NNNN` is the highest existing number plus one (both repositories share the numbering); `slug` is lowercase English with hyphens.
2. Set the status to 提议 (proposed), put the ADR in the same pull request as the related code, and add a row to the index in [docs/adr/README.md](docs/adr/README.md).
3. After review, set the status to 已接受 (accepted), then merge.
4. To overturn an accepted decision, write a new ADR and set the old one's status to 已被 ADR-NNNN 取代 (superseded by ADR-NNNN). The body of an accepted ADR is never rewritten; factual changes such as implementation status or versions go into a dated update record appended at the end.
5. ADRs are edited only in this repository and are written in Chinese. `docs/adr` in edgeweir-node is a mirror: run `scripts/sync-adr.sh` in the node repository to sync it, and `scripts/sync-adr.sh --check` to verify.

## Documentation

- Published docs are plain GitHub Markdown: `name.md` (Simplified Chinese, default) and `name.en.md` (English, same sections as `name.md`). ADRs are Chinese only.
- The documentation site lives in `doc/` (Fumadocs, Next.js static export) as its own pnpm workspace (`doc/pnpm-workspace.yaml`, `doc/pnpm-lock.yaml`). `.github/workflows/docs.yml` builds the site on pull requests and publishes it to GitHub Pages on pushes to `master`: <https://marvinli001.github.io/edgeweir/>.
- `doc/scripts/sync-content.mjs` holds the page map (`SECTIONS`) and converts the Markdown. A new page must be added to the page map.

| Markdown | Site |
| --- | --- |
| H1 | Page title |
| One-line paragraph right after the H1 | Page description |
| GitHub alerts (`> [!NOTE]`, etc.) | Callouts |
| Relative links to published pages | Site URLs |
| Relative links to other repository files | GitHub URLs |
| Broken relative links, raw HTML | CI build failure |

| Command | Effect |
| --- | --- |
| `pnpm --dir doc install` | Installs the site dependencies |
| `pnpm --dir doc dev` | Local site on `:3000` |
| `DOCS_BASE_PATH=/edgeweir pnpm --dir doc build` | Static export to `doc/out` |
| `DOCS_BASE_PATH=/edgeweir pnpm --dir doc preview` | Serves `doc/out` on `:4100` under `/edgeweir` |

## Pull request checklist

- [ ] One topic per pull request; the description states the motivation, the changes, and how they were verified, and links the issue or ADR.
- [ ] `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass; `pnpm build` and `pnpm e2e` run as listed in [Commands](#commands).
- [ ] Commits follow the [commit conventions](#commit-conventions).
- [ ] UI copy is updated in both zh-CN and en; new error codes have messages.
- [ ] Schema changes include the migration SQL, the snapshot, and the `ARCHITECTURE.md` data model update.
- [ ] New environment variables are in `env.ts`, `.env.example`, and the environment variables reference.
- [ ] Management actions write the audit log.
- [ ] UI changes include screenshots.
- [ ] Behavior changes are reflected in the Chinese and English docs (README, deployment docs, ADR implementation status).
- [ ] No test was skipped, deleted, or weakened.

## License

Edgeweir is released under [AGPL-3.0-only](LICENSE). Submitting a contribution licenses it under AGPL-3.0-only and confirms the right to do so.

The open core permits compliant commercial use. Organizations, members, access control, and isolation stay in the open core; the customer-facing portal, plans and billing, finance, and reselling belong to a separate commercial operations product ([LICENSING.en.md](LICENSING.en.md), [ADR-0019](docs/adr/0019-open-core-and-commercial-products.md)). Contributing to the core does not automatically grant the project a right to relicense under proprietary terms; a dual license or a plugin linking exception requires separate verification of code ownership and contributor authorization.
