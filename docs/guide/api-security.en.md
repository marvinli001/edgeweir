# API security

Configure endpoint discovery, OpenAPI request validation, JWT and GraphQL checks under **Sites → (site) → Security → API security**.

## Enable and save

All checks and endpoint discovery default to off. Each check has its own mode:

| Mode | Behavior |
| --- | --- |
| `off` | Does not run the check |
| `observe` | Records violations and continues processing the request |
| `enforce` | Blocks violations found by this check |

Edits change a draft. **Save** publishes it. Moving a check from off or observe to enforce requires **Save and enforce**. Observe real requests, correct the configuration and add necessary exceptions before enforcing.

Nodes run API security after access authentication and before cache lookup. Active nodes in the site's cluster need actual support for `api-security-v1`. The page reports unsupported nodes. A saved mode does not prove every node has applied it; check [node upgrades](node-upgrades.en.md) and the site's configuration delivery status.

## Endpoint discovery

**Sample endpoints** starts discovery. The default rate is 1000 basis points (10%); the range is 1–10000. Discovery retains at most 500 candidates for seven days.

| Field | Meaning |
| --- | --- |
| Method and path template | HTTP method and discovered template; named parameters such as `/users/{id}` are supported |
| Source | Sampled traffic, OpenAPI or manual confirmation |
| First/last seen | Time range of the discovery record |
| Sampled requests | Requests sampled and recorded |
| Sampled violations | Sampled records containing API check violations |
| Confirm/correct | Confirms a candidate or corrects its template; changes only the discovery record |

These are sample counts, not total traffic, unique visitors or business success rates. Automatic candidates and manual confirmation never create, enable or relax security policy. Validation uses explicitly saved schema endpoints.

## OpenAPI and schema validation

1. Choose **Import OpenAPI JSON** and paste JSON or select a JSON file.
2. Choose **Preview**. Review endpoints, parameter and body summaries, issue codes and issue locations.
3. Choose **Use preview** to replace the endpoints and import issues in the schema draft. This does not save them.
4. Select observe and save. Correct and reimport the source document until the issue list is empty before choosing enforce.

Import accepts OpenAPI 3.0 or 3.1 JSON only, up to 512 KiB and 200 endpoints. YAML is not accepted. Preview does not change site policy.

Endpoints match by method and path template. Validation covers path, query and header parameters and JSON request bodies; it does not validate response schemas. Supported schema keywords:

| Keyword | Scope |
| --- | --- |
| `type` | `string`, `number`, `integer`, `boolean`, `object`, `array`, `null` |
| `properties`, `required` | Object properties and required properties |
| `additionalProperties` | Boolean only |
| `items` | Array item schema |
| `enum` | Strings, numbers, booleans or `null` |
| `minLength`, `maxLength` | String length |
| `minItems`, `maxItems` | Array length |
| `minimum`, `maximum` | Numeric bounds |
| `nullable` | Nullable values |

Numeric constraints must round-trip through console JSON numbers without decimal precision loss or underflow. Numeric literals are limited to 128 bytes and decimal exponents from −308 to 308; unsupported values report their constraint location.

Access logs carrying API check metadata use the redacted template as their path and omit query strings, request headers, User-Agent and Referer, regardless of the site's ordinary log options.

Only complete request bodies with Content-Length up to 128 KiB are inspected. Chunked transfers and HTTP/2 or HTTP/3 without a length are treated as uninspectable: enforce blocks and observe records then continues. Checks that read a body also require an explicit length for an empty body. Invalid UTF-8 and unpaired Unicode surrogate escapes are rejected.

Internal `$ref` expansion is limited to eight levels and 2000 schema nodes. Remote and circular references, `pattern`/regular expressions, `format`, and combinators such as `allOf`, `anyOf` and `oneOf` are unsupported and cannot count as enforced constraints. Import issues include their document `location`; any issue prevents saving schema enforce mode. JSON request body processing is limited to 128 KiB.

**Unknown endpoints** controls methods and paths absent from the document: allow them, or record/block according to the mode. The latter records in observe and blocks in enforce. Schema off does not check unknown endpoints.

Methods and paths are case-sensitive and match the complete normalized node path. A parameter occupies one nonempty segment; trailing slashes are distinct. More static segments take precedence; overlapping templates of equal priority are rejected. Ambiguous encoded slashes, dot paths and semicolon parameters cannot receive API exceptions or inherit access-control encoded-path exemptions. Allowing unknown endpoints leaves other spellings, methods and paths outside schema protection; origins with case-insensitive routing need corresponding endpoints or unknown-endpoint blocking.

## JWT

JWT checks use static public keys to validate signatures and claims including issuer (`iss`), audience (`aud`), expiration (`exp`) and not-before (`nbf`). Observe and enforce require an issuer, at least one audience and public keys.

| Field | Scope |
| --- | --- |
| Issuer | Matches the token claim; up to 512 characters |
| Audiences | One per line, up to 16 |
| Algorithms | `RS256`, `ES256`, `EdDSA`; select at least one |
| Public JWKS | `{"keys":[...]}`, up to eight keys with unique `kid` values |
| Clock tolerance | 0–120 seconds; default 30 |
| Check scope | The domain, path-prefix, extension and excluded-path controls from [access authentication](access-control.en.md#scope-and-selection) |

Each public key needs `kid`, `alg` and `kty`. RSA uses public `n` and `e`; ES256 uses `crv: "P-256"`, `x` and `y`; EdDSA uses `crv: "Ed25519"` and `x`. The editor and API accept only these public key fields. Never paste private keys. Fields `d`, `p`, `q`, `dp`, `dq`, `qi`, `oth` and the symmetric key `k` are rejected; private material is never silently stripped to turn a private key into a public key.

There is no remote JWKS URL or periodic key retrieval, and no symmetric algorithms such as HMAC. To rotate, add the new public key, switch the issuer, then remove the old key and save. With JWT enabled, requests matching its scope bypass the cache to keep identities from sharing cached results. This also applies in observe mode.

## GraphQL

Checks parse HTTP GET/POST GraphQL requests at configured paths as ASTs and limit depth, fields after fragment expansion, aliases, batch size and document bytes. They do not validate a business GraphQL schema or authorize individual resolvers.

| Setting | Range | Default |
| --- | --- | --- |
| Path prefixes | 1–16, one per line | `/graphql` |
| Maximum depth | 1–30 | 10 |
| Maximum expanded fields | 1–1000 | 200 |
| Maximum aliases | 0–200 | 30 |
| Maximum batch size | 1–20 | 5 |
| Maximum document bytes | 256–65536 | 65536 |
| Allow introspection | On/off | Off |

An APQ/persisted-query identifier without query text is a violation. Nodes do not fetch the query from a remote service by hash. Observe only records these violations; enforce blocks them.

operationName selects the operation. Multiple operations without a name, unknown operations, and unknown or cyclic fragments are rejected. Variables must be an object or omitted/null. Fields and aliases are counted on each fragment expansion; conditional directives are counted conservatively, without estimating resolver cost. GET mutations are rejected. Disabling introspection blocks `__schema` and `__type` while allowing `__typename`.

## Check exceptions and results

Each exception specifies one check (schema, JWT or GraphQL), a method (or all methods), a path template, a reason and an enabled state. Up to 100 exceptions are supported. Adding, editing, toggling or deleting takes effect after saving. Reasons must be nonempty and at most 256 characters. An exception skips only its selected API check; other API checks, access authentication, WAF and other security policies still run.

Use a complete path template: `/users/{id}` matches parameter values such as `/users/42`; `/users` matches that path rather than every path starting with it. Manual confirmation in discovery changes only discovery metadata and does not configure an exception or schema policy.

Ambiguous or abnormally encoded paths are refused in enforce and recorded in observe. Do not use encoded paths to evade template or scope matching.

**Observation results** show the time, request ID, method, path template, check, code and mode, plus HTTP status and the number of matching exceptions. Correlate the request ID with [access logs](access-logs.en.md). An observe-mode violation does not mean the request was blocked. Only enforce-mode violations trigger an API check block.

Discovery candidates are deleted after seven days. Observation results query at most the last seven days and also depend on ordinary access-log retention; shorter log retention means fewer available results. API check metadata inside access logs has no separate seven-day expiry and remains stored according to the access-log settings.

## API and audit

Endpoints use the same [API credentials](../reference/api.en.md) as the console. Prefix paths with `/api/v1`:

| Method and path | Purpose |
| --- | --- |
| `GET /sites/{id}/api-security` | Returns `settings`, `updatedAt`, `unsupportedNodes` |
| `PUT /sites/{id}/api-security` | Submits complete `settings` and `expectedUpdatedAt` |
| `POST /sites/{id}/api-security/import` | Previews a string `document`; returns version, endpoints and issues |
| `GET /sites/{id}/api-security/results` | Returns discovery, observations, sample rate, retention days and unsupported node count |
| `PUT /sites/{id}/api-security/endpoints/{endpointId}` | Submits `path` to confirm or correct only the discovery record |

On a version conflict, fetch again and review the changes instead of overwriting another save. Settings changes record audit action `site.api_security_update`; discovery confirmation records `site.api_endpoint_confirm`. Invalid settings return `API_SECURITY_INVALID`, invalid imports return `API_SECURITY_IMPORT_INVALID`, and a discovery record that no longer exists returns `API_ENDPOINT_NOT_FOUND`.
