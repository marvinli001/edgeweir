import { oc } from "@orpc/contract";
import * as z from "zod";
import { isoDateTime } from "./schemas";

/**
 * MCP over OAuth (ADR-0076): the console is the authorization server and the
 * resource `<EDGEWEIR_PUBLIC_URL>/mcp`. Its access tokens work on /mcp only.
 */
export const MCP_PATH = "/mcp";

/** Reads: GET procedures and the POSTs read-only AccessKeys may call. */
export const MCP_SCOPE_READ = "edgeweir:read";
/** Everything a read token may do, and every change the operator may make. */
export const MCP_SCOPE_WRITE = "edgeweir:write";
/** Asks for a refresh token. */
export const MCP_SCOPE_OFFLINE = "offline_access";
export const mcpScopes = [MCP_SCOPE_READ, MCP_SCOPE_WRITE, MCP_SCOPE_OFFLINE] as const;

/** Off by default: open client registration and metadata fetches are attack surface. */
const mcpSettings = z.object({
  enabled: z.boolean(),
  /** The address MCP clients connect to. */
  url: z.string(),
});
export type McpSettings = z.infer<typeof mcpSettings>;

const mcpSettingsInput = z.object({ enabled: z.boolean() });

/** A client the operator authorized and that may still use its tokens. */
const connectedApp = z.object({
  clientId: z.string(),
  name: z.string(),
  /** Host of a URL client_id (metadata document), else of its first redirect URI. */
  host: z.string(),
  scopes: z.array(z.string()),
  grantedAt: isoDateTime,
  lastUsedAt: isoDateTime.nullable(),
});
export type ConnectedApp = z.infer<typeof connectedApp>;

/** The signed authorization request the console sent the browser to /oauth/consent with. */
const oauthQuery = z.string().min(1).max(8192);

const consentRequest = z.object({
  clientId: z.string(),
  clientName: z.string(),
  /** Host of a URL client_id; null for a registered client. */
  clientIdHost: z.string().nullable(),
  /** Host (and port) the authorization code goes to: the request's redirect URI. */
  redirectHost: z.string(),
  /** The redirect URI is on the browser's own machine (localhost, 127.0.0.1, [::1]). */
  localhost: z.boolean(),
  /** The scopes the client asked for, in mcpScopes order. */
  scopes: z.array(z.string()),
  /** The caller may grant reads only (the demo account). */
  readOnly: z.boolean(),
});
export type ConsentRequest = z.infer<typeof consentRequest>;

const consentInput = z.object({
  oauthQuery,
  accept: z.boolean(),
  /** "read" drops edgeweir:write from the grant. */
  access: z.enum(["read", "write"]),
});

export const mcpContract = {
  settings: oc.route({ method: "GET", path: "/mcp/settings", tags: ["mcp"] }).output(mcpSettings),
  /**
   * Switches MCP and its OAuth endpoints on or off. Off: /mcp, the OAuth endpoints and their
   * metadata answer 404 and tokens are refused, but grants stay.
   */
  setSettings: oc
    .route({ method: "PUT", path: "/mcp/settings", tags: ["mcp"] })
    .input(mcpSettingsInput)
    .output(mcpSettings),
  /** Authorized clients, newest grant first. */
  apps: oc
    .route({ method: "GET", path: "/mcp/apps", tags: ["mcp"] })
    .output(z.object({ apps: z.array(connectedApp) })),
  /** Deletes the grant and every token of the client; its next /mcp request answers 401. */
  revokeApp: oc
    .route({ method: "DELETE", path: "/mcp/apps/{clientId}", tags: ["mcp"] })
    .input(z.object({ clientId: z.string().min(1).max(2048) }))
    .output(z.object({ ok: z.literal(true) })),
  /** What /oauth/consent shows: the client and the scopes it asks for (session only). */
  consentRequest: oc
    .route({ method: "GET", path: "/mcp/consent", tags: ["mcp"] })
    .input(z.object({ oauthQuery }))
    .output(consentRequest),
  /** Grants or denies the request; `url` is where the browser goes next (the client). */
  consent: oc
    .route({ method: "POST", path: "/mcp/consent", tags: ["mcp"] })
    .input(consentInput)
    .output(z.object({ url: z.string() })),
};
