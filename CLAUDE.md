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
- Every UI string goes through Paraglide (`apps/console/messages/{zh-CN,en}.json`, keys in snake_case); tests enforce key/placeholder parity and no hard-coded CJK in components.
- UI: shadcn components under `components/ui` (Base UI `render` prop, not `asChild`); one ThemeProvider; every page has loading, empty and error states.
- UI copy is short and user-facing: no page subtitles, no dialog/card description paragraphs, empty states are a title plus an action. Keep only one-line safety notes (e.g. "shown once").
- Loading: never skeletons. `TopProgress` (2px bar) covers route loads, fetches and mutations; first loads render `LoadingState` (appica Loader); submit buttons show `Spinner` and disable. Polling queries set `meta: { background: true }`.
- appica-ui only through `src/web/components/appica/` and `appica-bridge.css` (scoped tokens, one `@source` per component); tests in `test/web/ui-rules.test.ts` enforce it. Entrances use `animate-enter` with a staggered `animationDelay`; respect reduced motion.
- Console vs admin: everyone uses the console (`/`, `/sites`, `/settings`); platform admins also get the header [Console | Admin] switch to `/admin/*` (platform overview, clusters & nodes, audit log, system settings). Admin-area procedures use the `admin` guard.
- API changes start in `packages/contract`; the same procedure serves `/rpc` (UI) and `/api/v1` (OpenAPI).
- Proto changes: edit `proto/`, `pnpm proto:lint`, `pnpm proto:gen`, tag `proto/vX.Y.Z`, regenerate in edgeweir-node.
- Schema changes: edit `packages/db/src/schema`, `pnpm db:generate`, commit the SQL.
- Management actions write `audit_log` via `recordAudit`.

## Non-negotiable principles

- No phone-home, no license checks; telemetry off unless explicitly enabled (third-party telemetry, e.g. better-auth's, is hard-disabled).
- Secrets (private keys, DNS API keys) are envelope-encrypted with `EDGEWEIR_MASTER_KEY` before they touch the database. Never store SSH credentials.
- The node channel terminates its own TLS; after enrollment every node RPC requires mTLS. Enrollment tokens are single-use and stored as SHA-256 only.
- `/api/v1` accepts only `x-api-key`; `/rpc` accepts only the session cookie plus the CSRF header.
- Never skip, delete or weaken tests to make something pass. Verify dependency APIs against official docs before use.
