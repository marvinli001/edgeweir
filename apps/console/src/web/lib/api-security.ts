import { type ApiSecuritySettings, apiSecuritySettings } from "@edgeweir/contract";

type Jwt = ApiSecuritySettings["jwt"];
type Graphql = ApiSecuritySettings["graphql"];
type GraphqlLimit = "maxDepth" | "maxFields" | "maxAliases" | "maxBatch" | "maxDocumentBytes";

export type ApiSecurityDraft = Omit<ApiSecuritySettings, "discovery" | "jwt" | "graphql"> & {
  discovery: { enabled: boolean; sampleRate: string };
  jwt: Omit<Jwt, "scope" | "audiences" | "keys" | "clockToleranceSeconds"> & {
    scope: {
      domains: string[];
      pathPrefixes: string;
      extensions: string;
      excludePathPrefixes: string;
    };
    audiences: string;
    jwks: string;
    clockToleranceSeconds: string;
  };
  graphql: Omit<Graphql, GraphqlLimit | "pathPrefixes"> &
    Record<GraphqlLimit, string> & { pathPrefixes: string };
};

const lines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

export function apiSecurityDraft(settings: ApiSecuritySettings): ApiSecurityDraft {
  return {
    ...settings,
    discovery: { ...settings.discovery, sampleRate: String(settings.discovery.sampleRate) },
    jwt: {
      mode: settings.jwt.mode,
      issuer: settings.jwt.issuer,
      algorithms: settings.jwt.algorithms,
      audiences: settings.jwt.audiences.join("\n"),
      jwks: JSON.stringify({ keys: settings.jwt.keys }, null, 2),
      clockToleranceSeconds: String(settings.jwt.clockToleranceSeconds),
      scope: {
        domains: settings.jwt.scope.domains,
        pathPrefixes: settings.jwt.scope.pathPrefixes.join("\n"),
        extensions: settings.jwt.scope.extensions.join(", "),
        excludePathPrefixes: settings.jwt.scope.excludePathPrefixes.join("\n"),
      },
    },
    graphql: {
      ...settings.graphql,
      pathPrefixes: settings.graphql.pathPrefixes.join("\n"),
      maxDepth: String(settings.graphql.maxDepth),
      maxFields: String(settings.graphql.maxFields),
      maxAliases: String(settings.graphql.maxAliases),
      maxBatch: String(settings.graphql.maxBatch),
      maxDocumentBytes: String(settings.graphql.maxDocumentBytes),
    },
  };
}

type DraftResult =
  | { success: true; settings: ApiSecuritySettings }
  | { success: false; code: "jwks" | "privateKey" | "schemaIssues" | "invalid"; field: string };

/** Private material is refused before any public-key fields can be selected. */
export function parsePublicJwks(
  text: string,
): { success: true; keys: Jwt["keys"] } | { success: false; code: "jwks" | "privateKey" } {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return { success: false, code: "jwks" };
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { success: false, code: "jwks" };
  }
  const fields = Object.keys(document);
  if (fields.length !== 1 || fields[0] !== "keys") return { success: false, code: "jwks" };
  const keys: unknown = (document as { keys: unknown }).keys;
  if (!Array.isArray(keys)) return { success: false, code: "jwks" };
  const privateFields = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];
  if (
    keys.some(
      (key) =>
        key && typeof key === "object" && privateFields.some((name) => Object.hasOwn(key, name)),
    )
  ) {
    return { success: false, code: "privateKey" };
  }
  const parsed = apiSecuritySettings.shape.jwt.shape.keys.safeParse(keys);
  return parsed.success ? { success: true, keys: parsed.data } : { success: false, code: "jwks" };
}

export function parseApiSecurityDraft(draft: ApiSecurityDraft): DraftResult {
  const jwks = parsePublicJwks(draft.jwt.jwks);
  if (!jwks.success) return { ...jwks, field: "jwt.keys" };
  if (draft.schema.mode === "enforce" && draft.schema.issues.length) {
    return { success: false, code: "schemaIssues", field: "schema.issues" };
  }
  const { jwks: _jwks, ...jwt } = draft.jwt;
  const parsed = apiSecuritySettings.safeParse({
    ...draft,
    discovery: {
      ...draft.discovery,
      sampleRate: draft.discovery.sampleRate.trim()
        ? Number(draft.discovery.sampleRate)
        : Number.NaN,
    },
    jwt: {
      ...jwt,
      audiences: lines(jwt.audiences),
      keys: jwks.keys,
      clockToleranceSeconds: jwt.clockToleranceSeconds.trim()
        ? Number(jwt.clockToleranceSeconds)
        : Number.NaN,
      scope: {
        domains: jwt.scope.domains,
        pathPrefixes: lines(jwt.scope.pathPrefixes),
        excludePathPrefixes: lines(jwt.scope.excludePathPrefixes),
        extensions: jwt.scope.extensions.split(/[\s,]+/).filter(Boolean),
      },
    },
    graphql: {
      ...draft.graphql,
      pathPrefixes: lines(draft.graphql.pathPrefixes),
      ...Object.fromEntries(
        (["maxDepth", "maxFields", "maxAliases", "maxBatch", "maxDocumentBytes"] as const).map(
          (key) => [key, draft.graphql[key].trim() ? Number(draft.graphql[key]) : Number.NaN],
        ),
      ),
    },
  });
  return parsed.success
    ? { success: true, settings: parsed.data }
    : { success: false, code: "invalid", field: parsed.error.issues[0]?.path.join(".") ?? "" };
}
