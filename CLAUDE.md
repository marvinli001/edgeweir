# CLAUDE.md — edgeweir (console)

Self-hosted CDN / WAF / edge scheduling control plane. One app package, one Node.js process, one image: web UI + API (:3000) + node channel (:8443) + pg-boss worker. Edge nodes live in the sibling repo `edgeweir-node`.

## Stack

Node.js 24 LTS · pnpm 12 workspace + Turborepo · TypeScript 7 (strict) · Biome · Vitest · Playwright · Vite 8 + React 19 + TanStack Router/Query/Table · shadcn (preset `b2D0wqNxT`, Base UI, Hugeicons) · Paraglide (zh-CN default, en) · Hono · oRPC + zod 4 · better-auth · PostgreSQL 18 + Drizzle (plain SQL migrations) · pg-boss · Connect-RPC + buf.

## Commands

```bash
pnpm install
docker compose -f compose.dev.yml up -d && cp .env.example .env   # fill secrets
pnpm dev            # API + node channel + Vite HMR in one process
pnpm lint           # biome check + buf lint
pnpm typecheck
pnpm test           # vitest (PGlite, no Docker needed)
pnpm build
pnpm proto:gen      # regenerate packages/proto from proto/
pnpm db:generate    # drizzle-kit migration from schema changes
docker compose -f compose.e2e.yml up -d --build && pnpm e2e   # needs ../edgeweir-node
```

## Conventions

- Conventional Commits, small steps. Scopes: console, web, api, db, contract, compiler, proto, node-channel, certd, deploy, e2e.
- Every UI string goes through Paraglide (`apps/console/messages/{zh-CN,en}.json`, keys in snake_case); tests enforce key/placeholder parity and no hard-coded CJK or English text in components (including `aria-*`, `title`, `alt`, `placeholder`). The landing page is the only place with marketing copy, still through Paraglide.
- UI: shadcn components under `components/ui` (Base UI `render` prop, not `asChild`); one ThemeProvider; every page has loading, empty and error states.
- UI copy is short and user-facing: no page subtitles, no dialog/card description paragraphs, empty states are a title plus an action. Keep only one-line safety notes (e.g. "shown once").
- Loading: never skeletons. `TopProgress` (2px bar) covers route loads, fetches and mutations; first loads render `LoadingState` (appica Loader); submit buttons show `Spinner` and disable. Polling queries set `meta: { background: true }`.
- appica-ui only through `src/web/components/appica/` and `appica-bridge.css` (scoped tokens, one `@source` per component); tests in `test/web/ui-rules.test.ts` enforce it, and also forbid Skeleton/`animate-pulse`, `*Description` components (one-line notes use `SafetyNote`), color literals in TS/TSX (use CSS tokens) and URLs of other sites. Entrances use `animate-enter` with a staggered `animationDelay`; respect reduced motion.
- Console vs admin: everyone uses the console (`/overview`, `/sites`, `/purge`, `/members`, `/security`, `/settings`); platform admins also get the header [Console | Admin] switch to `/admin/*` (platform overview, clusters & nodes, regions, organizations & users, audit log, system settings). `/` is the public landing page (template picked in system settings, `landing` procedures) and redirects to `/overview` while it is off. Admin-area procedures use the `admin` guard; tenant procedures use `tenant` (blocks until a required 2FA is on), member management uses `orgManager`.
- Errors: throw `fail(CODE, message, data)` with a code from `packages/contract/src/errors.ts` and add `error_<code>` messages; revision reasons are codes too (`revision_reason_<code>`). Tests enforce both.
- API changes start in `packages/contract`; the same procedure serves `/rpc` (UI) and `/api/v1` (OpenAPI).
- Proto changes: edit `proto/`, `pnpm proto:lint`, `pnpm proto:gen`, tag `proto/vX.Y.Z`, regenerate in edgeweir-node.
- Schema changes: edit `packages/db/src/schema`, `pnpm db:generate`, commit the SQL.
- Management actions write `audit_log` via `recordAudit` inside the change's transaction. better-auth's own endpoints are audited by the hooks in `lib/auth-audit.ts`.
- better-auth HTTP endpoints are allow-listed in `lib/auth.ts` (`AUTH_HTTP_ROUTES`); everything else under `/api/auth` is 404. The organization and admin plugins are used server side only (`auth.api.*`).
- Client IPs come from `resolveClientIp` (TCP peer; forwarding headers only from `EDGEWEIR_TRUSTED_PROXIES`), never from headers directly.
- Envelopes are bound to their row: `masterKey.seal(value, { purpose: "<table>.<column>", recordId })`.
- A new environment variable goes into `lib/env.ts` and `.env.example` (a test checks); origin addresses go through `packages/contract/src/addresses.ts` (the node keeps the same list).
- Docs: `docs/adr` is the ADR source (edgeweir-node mirrors it with its `scripts/sync-adr.sh`); never rewrite an accepted ADR, append a dated update record. `docs/audits/*` and `BOOTSTRAP.md` are frozen requirement sources. Language: README in both languages, ADR/ARCHITECTURE/ROADMAP/specs mostly Chinese, SECURITY Chinese plus an English summary, this file English.

## Non-negotiable principles

- No phone-home, no license checks; telemetry off unless explicitly enabled (third-party telemetry, e.g. better-auth's, is hard-disabled).
- Secrets (private keys, DNS API keys) are envelope-encrypted with `EDGEWEIR_MASTER_KEY` before they touch the database. Never store SSH credentials.
- The node channel terminates its own TLS; after enrollment every node RPC requires mTLS. Enrollment tokens are single-use and stored as SHA-256 only.
- `/api/v1` accepts only `x-api-key`; `/rpc` accepts only the session cookie plus the CSRF header.
- Never skip, delete or weaken tests to make something pass. Verify dependency APIs against official docs before use.
