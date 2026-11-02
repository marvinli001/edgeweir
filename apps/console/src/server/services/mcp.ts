import { createHash } from "node:crypto";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import {
  type ConnectedApp,
  type ConsentRequest,
  MCP_SCOPE_READ,
  MCP_SCOPE_WRITE,
  type McpSettings,
  mcpScopes,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, desc, eq, isNull, lt, notExists, or, sql } from "drizzle-orm";
import * as z from "zod";
import { mcpIssuer, mcpResourceUrl, OAUTH_ACCESS_TOKEN_PREFIX } from "../lib/auth";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { deleteInBatches } from "../lib/retention";
import { type Actor, recordAudit } from "./audit";
import type { Executor } from "./revisions";
import { defineSetting } from "./settings";

/**
 * MCP over OAuth (ADR-0076). Off by default: while off, /mcp, the OAuth endpoints and their
 * metadata answer 404 and tokens are refused; grants and tokens stay.
 */
const MCP_SETTINGS_KEY = "mcp_settings";

const mcpSetting = defineSetting({
  key: MCP_SETTINGS_KEY,
  schema: z.object({ enabled: z.boolean() }),
  defaults: { enabled: false },
  auditAction: "mcp.settings_update",
  targetName: MCP_SETTINGS_KEY,
});

/** Read on every request, so switching off applies at once. */
export async function mcpEnabled(db: Executor): Promise<boolean> {
  return (await mcpSetting.read(db)).enabled;
}

export async function getMcpSettings(app: AppContext): Promise<McpSettings> {
  return {
    enabled: await mcpEnabled(app.db),
    url: mcpResourceUrl(app.env.EDGEWEIR_PUBLIC_URL),
  };
}

export async function setMcpSettings(
  app: AppContext,
  input: { enabled: boolean },
  actor: Actor,
): Promise<McpSettings> {
  await app.db.transaction((tx) => mcpSetting.write(tx, actor, input.enabled ? input : null));
  return getMcpSettings(app);
}

/** The OAuth grant a /mcp request acts with (the `oauth` caller of rpc/base.ts). */
export interface OAuthPrincipal {
  clientId: string;
  clientName: string;
  /** The grant's id (oauth_consent): its request limit and last use. */
  grantId: string;
  user: typeof schema.user.$inferSelect;
  scopes: string[];
  /** Seconds since the epoch. */
  expiresAt: number;
}

/** A grant's last /mcp request is written at most this often. */
const LAST_USED_RESOLUTION_MS = 60_000;

/** Stored form of an opaque token: better-auth's default hasher, SHA-256 in unpadded base64url. */
const hashOAuthToken = (token: string) => createHash("sha256").update(token).digest("base64url");

const OAUTH_TOKEN_FORMAT = /^ewo_[A-Za-z]{32,128}$/;

/**
 * The grant behind a /mcp bearer token, or null: unknown, expired or revoked token, a token for
 * another audience, a sender-constrained (DPoP) token, a disabled client or a grant the operator
 * revoked. One lookup per request, so revocation applies at once.
 */
export async function authenticateMcpToken(
  app: AppContext,
  token: string,
  now = new Date(),
): Promise<OAuthPrincipal | null> {
  if (!OAUTH_TOKEN_FORMAT.test(token)) return null;
  const [row] = await app.db
    .select({
      token: schema.oauthAccessToken,
      client: schema.oauthClient,
      grant: schema.oauthConsent,
      user: schema.user,
    })
    .from(schema.oauthAccessToken)
    .innerJoin(
      schema.oauthClient,
      eq(schema.oauthClient.clientId, schema.oauthAccessToken.clientId),
    )
    .innerJoin(schema.user, eq(schema.user.id, schema.oauthAccessToken.userId))
    .innerJoin(
      schema.oauthConsent,
      and(
        eq(schema.oauthConsent.clientId, schema.oauthAccessToken.clientId),
        eq(schema.oauthConsent.userId, schema.oauthAccessToken.userId),
      ),
    )
    .where(
      eq(
        schema.oauthAccessToken.token,
        hashOAuthToken(token.slice(OAUTH_ACCESS_TOKEN_PREFIX.length)),
      ),
    )
    .limit(1);
  if (!row) return null;
  const { token: stored, client, grant, user } = row;
  if (stored.revoked || !stored.expiresAt || stored.expiresAt <= now) return null;
  if (client.disabled) return null;
  if (stored.confirmation !== null) return null;
  if (!stored.resources?.includes(mcpResourceUrl(app.env.EDGEWEIR_PUBLIC_URL))) return null;
  const stale = new Date(now.getTime() - LAST_USED_RESOLUTION_MS);
  if (!grant.lastUsedAt || grant.lastUsedAt < stale)
    await app.db
      .update(schema.oauthConsent)
      .set({ lastUsedAt: now })
      .where(
        and(
          eq(schema.oauthConsent.id, grant.id),
          or(isNull(schema.oauthConsent.lastUsedAt), lt(schema.oauthConsent.lastUsedAt, stale)),
        ),
      );
  return {
    clientId: client.clientId,
    clientName: clientName(client),
    grantId: grant.id,
    user,
    // A grant narrowed after the token was issued narrows the token too.
    scopes: stored.scopes.filter((scope) => grant.scopes.includes(scope)),
    expiresAt: Math.floor(stored.expiresAt.getTime() / 1000),
  };
}

type ClientRow = typeof schema.oauthClient.$inferSelect;

function clientName(client: ClientRow): string {
  return client.name?.trim() || clientHost(client) || client.clientId;
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** Host of a URL client_id (metadata document), else of the first redirect URI. */
function clientHost(client: ClientRow): string {
  return hostOf(client.clientId) ?? hostOf(client.redirectUris[0]) ?? "";
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** In mcpScopes order, without duplicates or unknown scopes. */
function orderScopes(scopes: readonly string[]): string[] {
  return mcpScopes.filter((scope) => scopes.includes(scope));
}

/** The operator's grants, newest first. */
export async function listConnectedApps(db: Executor, userId: string): Promise<ConnectedApp[]> {
  const rows = await db
    .select({ grant: schema.oauthConsent, client: schema.oauthClient })
    .from(schema.oauthConsent)
    .innerJoin(schema.oauthClient, eq(schema.oauthClient.clientId, schema.oauthConsent.clientId))
    .where(eq(schema.oauthConsent.userId, userId))
    .orderBy(desc(schema.oauthConsent.updatedAt));
  return rows.map(({ grant, client }) => ({
    clientId: client.clientId,
    name: clientName(client),
    host: clientHost(client),
    scopes: orderScopes(grant.scopes),
    grantedAt: (grant.updatedAt ?? grant.createdAt ?? new Date(0)).toISOString(),
    lastUsedAt: grant.lastUsedAt?.toISOString() ?? null,
  }));
}

/**
 * Removes a client's grant with every access and refresh token it holds; its next /mcp request
 * answers 401 and it has to be authorized again.
 */
export async function revokeConnectedApp(
  db: Database,
  userId: string,
  clientId: string,
  actor: Actor,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [found] = await tx
      .select({ grant: schema.oauthConsent, client: schema.oauthClient })
      .from(schema.oauthConsent)
      .innerJoin(schema.oauthClient, eq(schema.oauthClient.clientId, schema.oauthConsent.clientId))
      .where(
        and(eq(schema.oauthConsent.clientId, clientId), eq(schema.oauthConsent.userId, userId)),
      );
    if (!found) fail("OAUTH_APP_NOT_FOUND", "no such authorized application");
    await tx
      .delete(schema.oauthAccessToken)
      .where(
        and(
          eq(schema.oauthAccessToken.clientId, clientId),
          eq(schema.oauthAccessToken.userId, userId),
        ),
      );
    await tx
      .delete(schema.oauthRefreshToken)
      .where(
        and(
          eq(schema.oauthRefreshToken.clientId, clientId),
          eq(schema.oauthRefreshToken.userId, userId),
        ),
      );
    await tx.delete(schema.oauthConsent).where(eq(schema.oauthConsent.id, found.grant.id));
    await recordAudit(tx, actor, {
      action: "oauth.revoke",
      targetType: "oauth_client",
      targetId: clientId,
      targetName: clientName(found.client),
      metadata: { scopes: orderScopes(found.grant.scopes) },
    });
  });
}

/** The authorization request of /oauth/consent, after its signature and expiry check out. */
async function signedRequest(app: AppContext, oauthQuery: string) {
  const { secret } = await app.auth.$context;
  const valid = await verifyOAuthQueryParams(oauthQuery, secret).catch(() => false);
  const params = new URLSearchParams(oauthQuery);
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  if (!valid || !clientId || !redirectUri)
    fail("OAUTH_REQUEST_INVALID", "the authorization request is invalid or has expired");
  const [client] = await app.db
    .select()
    .from(schema.oauthClient)
    .where(eq(schema.oauthClient.clientId, clientId));
  if (!client || client.disabled)
    fail("OAUTH_REQUEST_INVALID", "the authorization request is invalid or has expired");
  const requested = params.get("scope")?.split(" ").filter(Boolean) ?? client.scopes ?? [];
  return { client, redirectUri, scopes: orderScopes(requested) };
}

/** The caller of a consent procedure: the operator's (or the demo account's) browser session. */
interface ConsentCaller {
  headers: Headers;
  actor: Actor;
  demo: boolean;
}

function requireSession(caller: ConsentCaller) {
  if (caller.actor.type !== "user")
    fail("OAUTH_SESSION_REQUIRED", "authorizing an application takes a signed-in session");
}

export async function getConsentRequest(
  app: AppContext,
  caller: ConsentCaller,
  oauthQuery: string,
): Promise<ConsentRequest> {
  requireSession(caller);
  if (!(await mcpEnabled(app.db))) fail("MCP_DISABLED", "MCP is switched off");
  const { client, redirectUri, scopes } = await signedRequest(app, oauthQuery);
  const redirect = new URL(redirectUri);
  return {
    clientId: client.clientId,
    clientName: clientName(client),
    clientIdHost: hostOf(client.clientId),
    redirectHost: redirect.host,
    localhost: LOOPBACK_HOSTS.has(redirect.hostname),
    scopes,
    readOnly: caller.demo,
  };
}

/**
 * Answers the authorization request through better-auth's consent endpoint, which stores the
 * grant and returns where the browser goes next (the client's redirect URI with a code, or an
 * access_denied error). "read" (and the demo account, always) drops edgeweir:write; a request
 * that then grants nothing it asked for is denied.
 */
export async function answerConsent(
  app: AppContext,
  caller: ConsentCaller,
  input: { oauthQuery: string; accept: boolean; access: "read" | "write" },
): Promise<{ url: string }> {
  requireSession(caller);
  if (!(await mcpEnabled(app.db))) fail("MCP_DISABLED", "MCP is switched off");
  const { client, scopes } = await signedRequest(app, input.oauthQuery);
  const readOnly = input.access === "read" || caller.demo;
  const granted = readOnly ? scopes.filter((scope) => scope !== MCP_SCOPE_WRITE) : scopes;
  const accept =
    input.accept && (granted.includes(MCP_SCOPE_READ) || granted.includes(MCP_SCOPE_WRITE));
  // Through the handler, not auth.api: the endpoint runs the authorization request again,
  // which needs a request. Its HTTP route is not on the allow list (lib/auth.ts).
  const headers = new Headers(caller.headers);
  headers.set("content-type", "application/json");
  headers.set("accept", "application/json");
  headers.set("origin", new URL(app.env.EDGEWEIR_PUBLIC_URL).origin);
  const response = await app.auth.handler(
    new Request(`${mcpIssuer(app.env.EDGEWEIR_PUBLIC_URL)}/oauth2/consent`, {
      method: "POST",
      headers,
      body: JSON.stringify({ accept, scope: granted.join(" "), oauth_query: input.oauthQuery }),
    }),
  );
  const result = (await response.json().catch(() => ({}))) as { url?: unknown };
  if (!response.ok || typeof result.url !== "string")
    fail("OAUTH_REQUEST_INVALID", "the authorization request is invalid or has expired");
  if (accept)
    await recordAudit(app.db, caller.actor, {
      action: "oauth.consent_grant",
      targetType: "oauth_client",
      targetId: client.clientId,
      targetName: clientName(client),
      metadata: { scopes: granted, requested: scopes },
    });
  return { url: result.url };
}

/** Clients nobody authorized are deleted this long after they registered (or were discovered). */
const UNUSED_CLIENT_TTL_MS = 30 * 24 * 3600_000;

/**
 * Hourly: expired access tokens, expired or revoked refresh tokens, and clients without a grant
 * 30 days after they appeared (open registration must not grow the table forever).
 */
export async function pruneOAuth(db: Executor, now = new Date()): Promise<number> {
  const accessTokens = await deleteInBatches(
    db,
    schema.oauthAccessToken,
    lt(schema.oauthAccessToken.expiresAt, now),
  );
  const refreshTokens = await deleteInBatches(
    db,
    schema.oauthRefreshToken,
    or(
      lt(schema.oauthRefreshToken.expiresAt, now),
      lt(schema.oauthRefreshToken.revoked, new Date(now.getTime() - 24 * 3600_000)),
    ),
  );
  const clients = await deleteInBatches(
    db,
    schema.oauthClient,
    and(
      lt(schema.oauthClient.createdAt, new Date(now.getTime() - UNUSED_CLIENT_TTL_MS)),
      notExists(
        sql`(select 1 from ${schema.oauthConsent} where ${schema.oauthConsent.clientId} = ${schema.oauthClient.clientId})`,
      ),
    ),
  );
  return accessTokens + refreshTokens + clients;
}
