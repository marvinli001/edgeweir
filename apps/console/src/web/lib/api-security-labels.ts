import type { ApiSecurityResults, ApiSecuritySettings } from "@edgeweir/contract";
import { m } from "../paraglide/messages.js";

export const apiCheckLabel = (check: ApiSecuritySettings["exceptions"][number]["check"]): string =>
  ({ schema: m.api_security_schema, jwt: m.api_security_jwt, graphql: m.api_security_graphql })[
    check
  ]();

export const apiModeLabel = (mode: ApiSecuritySettings["schema"]["mode"]): string =>
  ({
    off: m.api_security_mode_off,
    observe: m.api_security_mode_observe,
    enforce: m.api_security_mode_enforce,
  })[mode]();

export const apiSourceLabel = (source: ApiSecurityResults["endpoints"][number]["source"]): string =>
  ({
    traffic: m.api_security_source_traffic,
    schema: m.api_security_source_schema,
    manual: m.api_security_source_manual,
  })[source]();

export function apiFieldLabel(path: string): string {
  const labels: Record<string, () => string> = {
    discovery: m.api_security_discovery,
    sampleRate: m.api_security_sample_rate,
    schema: m.api_security_schema,
    endpoints: m.api_security_schema_endpoints,
    jwt: m.api_security_jwt,
    issuer: m.api_security_issuer,
    audiences: m.api_security_audiences,
    algorithms: m.api_security_algorithms,
    keys: m.api_security_jwks,
    clockToleranceSeconds: m.api_security_clock_tolerance,
    domains: m.auth_domains,
    pathPrefixes: m.auth_path_prefixes,
    excludePathPrefixes: m.auth_exclude_prefixes,
    extensions: m.auth_extensions,
    graphql: m.api_security_graphql,
    maxDepth: m.api_security_max_depth,
    maxFields: m.api_security_max_fields,
    maxAliases: m.api_security_max_aliases,
    maxBatch: m.api_security_max_batch,
    maxDocumentBytes: m.api_security_max_document_bytes,
    exceptions: m.api_security_exceptions,
    reason: m.api_security_exception_reason,
    path: m.api_security_path,
  };
  for (const segment of path.split(".").reverse()) {
    if (labels[segment]) return labels[segment]();
  }
  return m.site_tab_api_security();
}
