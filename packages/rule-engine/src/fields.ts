import type { Expression, ValueType } from "./model.ts";

export const fields: Record<string, ValueType> = {
  "http.host": "string",
  "http.request.method": "string",
  "http.request.uri.path": "string",
  "http.request.uri.query": "string",
  "http.request.uri": "string",
  "http.response.code": "number",
  "ip.src": "ip",
  ssl: "boolean",
  "ip.geoip.country": "string",
  "ip.geoip.subdivision": "string",
  "ip.geoip.asnum": "number",
  // JA4 TLS client fingerprint of the connection; empty over plain HTTP.
  "tls.ja4": "string",
  // rules-v2: scheme://host followed by the request URI as received.
  "http.request.full_uri": "string",
  // rules-v2: lowercase text after the last "." of the last path segment ("" without one).
  "http.request.uri.path.extension": "string",
  // rules-v2: lowercase media type of the response's Content-Type, parameters removed.
  "http.response.content_type.media_type": "string",
  // rules-v3: the Referer and User-Agent request headers (like http.request.headers[...]).
  "http.referer": "string",
  "http.user_agent": "string",
  // rules-v3: HTTP/1.0, HTTP/1.1, HTTP/2.0 or HTTP/3.0.
  "http.request.version": "string",
  // rules-v3: http or https.
  "http.request.scheme": "string",
  // rules-v3: the node's request id (X-Request-Id).
  "http.request.id": "string",
  // rules-v3: Unix seconds when the node received the request.
  "http.request.timestamp.sec": "number",
  // rules-v3: port of the listener that received the request.
  "edge.server_port": "number",
  // rules-v3: name of the AS (geoip-asn-v1); "" without a record.
  "ip.geoip.as_name": "string",
  // rules-v3: the edge cache's status of the response; "" for responses the node made itself.
  "http.response.cache_status": "string",
  // client-ip-v1: the TCP (QUIC: UDP) peer; ip.src is the client the cluster's client address
  // setting names (equal without one).
  "ip.peer": "ip",
  // client-cert-v1: the visitor's client certificate (mutual TLS) verified against the site's
  // client CA; the lowercase hex SHA-256 of its DER and its subject (RFC 2253), "" without a
  // certificate. false / "" over plain HTTP.
  "tls.client.verified": "boolean",
  "tls.client.cert_sha256": "string",
  "tls.client.subject": "string",
  // rules-body-v1: Content-Length (-1 without), the body read (requests up to the site's limit),
  // whether it was not read, and the file names of a multipart body joined by "\n".
  "http.request.body.size": "number",
  "http.request.body.raw": "string",
  "http.request.body.truncated": "boolean",
  "http.request.body.filenames": "string",
  // challenge-v2: a search engine crawler the node verified by reverse and forward DNS.
  "http.request.bot.verified": "boolean",
  "http.request.bot.name": "string",
};
/** Fields of one request cookie and one query parameter by name (rules-v3), besides headers. */
export const COOKIE_FIELD = "http.request.cookies";
export const ARG_FIELD = "http.request.uri.args";
/** Cookie names (RFC 6265 tokens), case-sensitive. */
export const COOKIE_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
/** Query parameter names as sent (not decoded): printable ASCII without `"`, `#`, `&` and `=`. */
export const ARG_NAME_RE = /^[\x21\x24\x25\x27-\x3c\x3e-\x7e]{1,64}$/;
/** Fields only nodes with rules-v2 provide. */
export const rulesV2Fields: ReadonlySet<string> = new Set([
  "http.request.full_uri",
  "http.request.uri.path.extension",
  "http.response.content_type.media_type",
]);
/** Fields only nodes with rules-v3 provide (besides cookies and query parameters by name). */
export const rulesV3Fields: ReadonlySet<string> = new Set([
  "http.referer",
  "http.user_agent",
  "http.request.version",
  "http.request.scheme",
  "http.request.id",
  "http.request.timestamp.sec",
  "edge.server_port",
  "ip.geoip.as_name",
  "http.response.cache_status",
]);
/** Fields only nodes with client-ip-v1 provide. */
const clientIpFields: ReadonlySet<string> = new Set(["ip.peer"]);
/** Whether the expression reads a field only client-ip-v1 nodes provide. */
export function needsClientIp(expression: Expression): boolean {
  return (
    (expression.op !== "call" && clientIpFields.has(expression.field)) ||
    expression.children.some(needsClientIp)
  );
}
/** Fields only nodes with client-cert-v1 provide. */
const clientCertificateFields: ReadonlySet<string> = new Set([
  "tls.client.verified",
  "tls.client.cert_sha256",
  "tls.client.subject",
]);
/** Whether the expression reads the visitor's client certificate (client-cert-v1). */
export function needsClientCertificate(expression: Expression): boolean {
  return (
    (expression.op !== "call" && clientCertificateFields.has(expression.field)) ||
    expression.children.some(needsClientCertificate)
  );
}
/** Whether `field` is a rules-v3 field: one of rulesV3Fields, a cookie or a query parameter. */
export function isRulesV3Field(field: string): boolean {
  return (
    rulesV3Fields.has(field) ||
    field.startsWith(`${COOKIE_FIELD}.`) ||
    field.startsWith(`${ARG_FIELD}.`)
  );
}
/**
 * Error page placeholders only rules-v3 nodes replace (the UTC time in RFC 3339 and the request
 * path); nodes require the feature for configurations whose pages use them.
 */
export const RULES_V3_PLACEHOLDERS = ["{{time}}", "{{path}}"] as const;
/** Whether an error page template uses a placeholder only nodes with rules-v3 replace. */
export function usesRulesV3Placeholders(template: string): boolean {
  return RULES_V3_PLACEHOLDERS.some((placeholder) => template.includes(placeholder));
}
/** Phases that may read response fields. */
export const responsePhases: ReadonlySet<string> = new Set(["response-transform", "compression"]);
/**
 * Phases that may read the request body and crawler fields (and call form_value and
 * json_value): the request phases, not cache (cache rules judge the client's original request)
 * nor the response phases (the node cannot wait for the body or DNS there).
 */
export const requestPhases: ReadonlySet<string> = new Set([
  "request-transform",
  "redirect",
  "config",
  "waf-custom",
  "ratelimit",
  "origin",
]);
/** Fields only nodes with rules-body-v1 provide; they read the request body. */
export const bodyFields: ReadonlySet<string> = new Set([
  "http.request.body.size",
  "http.request.body.raw",
  "http.request.body.truncated",
  "http.request.body.filenames",
]);
/** Functions over the request body (rules-body-v1). */
export const bodyFunctions: ReadonlySet<string> = new Set(["form_value", "json_value"]);
/** Fields only nodes with challenge-v2 provide (verified crawlers). */
export const botFields: ReadonlySet<string> = new Set([
  "http.request.bot.verified",
  "http.request.bot.name",
]);
/**
 * Rule fields of installed node extensions (extensions-v1): `ext.<id>.<name>`
 * with the type their manifest declares. The console registers them from its
 * installed extensions; an unregistered `ext.` field is unknown.
 */
const extensionFields = new Map<string, ValueType>();
export const EXTENSION_FIELD_PREFIX = "ext.";
/** Replaces the registered extension fields. */
export function registerExtensionFields(entries: Iterable<[string, ValueType]>): void {
  extensionFields.clear();
  for (const [name, type] of entries) {
    if (name.startsWith(EXTENSION_FIELD_PREFIX)) extensionFields.set(name, type);
  }
}
export const extensionFieldType = (field: string): ValueType | undefined =>
  extensionFields.get(field);
/** Whether the expression reads an extension field. */
export function needsExtensionFields(expression: Expression): boolean {
  return (
    (expression.op !== "call" && expression.field.startsWith(EXTENSION_FIELD_PREFIX)) ||
    expression.children.some(needsExtensionFields)
  );
}

/** Whether a field or function is only available in the request phases. */
export const requestOnly = (op: string, name: string) =>
  op === "call"
    ? bodyFunctions.has(name)
    : bodyFields.has(name) || botFields.has(name) || name.startsWith(EXTENSION_FIELD_PREFIX);
/** Whether the expression reads the request body (rules-body-v1). */
export function needsRulesBody(expression: Expression): boolean {
  return (
    (expression.op === "call"
      ? bodyFunctions.has(expression.field)
      : bodyFields.has(expression.field)) || expression.children.some(needsRulesBody)
  );
}
/** Whether the expression reads the verified crawler fields (challenge-v2). */
export function needsBotFields(expression: Expression): boolean {
  return (
    (expression.op !== "call" && botFields.has(expression.field)) ||
    expression.children.some(needsBotFields)
  );
}
