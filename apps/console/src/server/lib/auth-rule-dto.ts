import {
  type AuthKind,
  type AuthRule,
  authScope,
  forwardAuthSettings,
  isUrlAuthKind,
} from "@edgeweir/contract";
import type { schema } from "@edgeweir/db";

export type AuthRuleRow = typeof schema.siteAuthRule.$inferSelect;
type Scope = AuthRule["scope"];
const EMPTY_SCOPE: Scope = {
  domains: [],
  pathPrefixes: [],
  extensions: [],
  excludePathPrefixes: [],
};

/** A stored scope, as the contract reads it (defaults for anything missing). */
function readScope(value: unknown): Scope {
  const parsed = authScope.safeParse(value ?? {});
  return parsed.success ? parsed.data : EMPTY_SCOPE;
}

const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback: number) => (typeof v === "number" ? v : fallback);
const bool = (v: unknown) => v === true;
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((s) => typeof s === "string") : []);

/** A stored rule as the API returns it: no hashes, no keys. */
export function toAuthRuleDto(row: AuthRuleRow): AuthRule {
  const s = row.settings as Record<string, unknown>;
  const kind = row.kind as AuthKind;
  const forward = forwardAuthSettings.safeParse(s);
  return {
    id: row.id,
    kind,
    enabled: row.enabled,
    scope: readScope(row.scope),
    basic:
      kind === "basic"
        ? {
            realm: str(s.realm, ""),
            keepAuthorization: bool(s.keepAuthorization),
            userHeader: bool(s.userHeader),
            users: strings(s.users).map((name) => ({ name })),
          }
        : null,
    forward: kind === "forward" && forward.success ? forward.data : null,
    url: isUrlAuthKind(kind)
      ? {
          validitySeconds: num(s.validitySeconds, 1800),
          skewSeconds: num(s.skewSeconds, 300),
          signParam: str(s.signParam, "sign"),
          timeParam: str(s.timeParam, "t"),
          backupKey: bool(s.backupKey),
        }
      : null,
  };
}
