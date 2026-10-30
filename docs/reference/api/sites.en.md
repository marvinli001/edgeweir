# API: Sites

The 51 procedures of sites, tags, copies, cache tasks, HTTPS, error pages, access authentication and control, image conversion, usage protection and mitigation.

Access levels, authentication, idempotency keys and the error format: [API overview](../api.en.md).

## Sites

- Writes publish a configuration revision of the site's cluster and write the audit entry in the same transaction: create `site_created` / `site.create`, update `site_updated` / `site.update` (metadata `changed` lists the parts changed), delete `site_deleted` / `site.delete`. When the compiled configuration equals the latest revision no revision is created and the response's `revision` is the latest one.
- Writes require every stored rule of the site to compile (otherwise 400 `RULE_INVALID`). More than 512 enabled sites in a cluster: 409 `CLUSTER_SITE_LIMIT`.
- A service account whose change needs a node capability an active node of the cluster lacks gets 409 `NODE_CAPABILITY_REQUIRED` (`data.features`, `data.nodes`) and nothing is saved; the operator's calls are saved.
- Behaviour: [Site management](../../guide/site-management.en.md), [Origins and cache](../../guide/origins-and-cache.en.md) and [Domains](../../guide/domains.en.md).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`sites.list`](#siteslist) | `GET /sites` | read; service account `sites:read` |
| [`sites.get`](#sitesget) | `GET /sites/{id}` | read; service account `sites:read` |
| [`sites.create`](#sitescreate) | `POST /sites` | write |
| [`sites.update`](#sitesupdate) | `PATCH /sites/{id}` | write |
| [`sites.delete`](#sitesdelete) | `DELETE /sites/{id}` | write |
| [`sites.launch`](#siteslaunch) | `GET /sites/{id}/launch` | read; service account `sites:read` |
| [`sites.originHealth`](#sitesoriginhealth) | `GET /sites/{id}/origin-health` | read |
| [`sites.originQuality`](#sitesoriginquality) | `GET /sites/{id}/origins/quality` | read |
| [`sites.features`](#sitesfeatures) | `GET /sites/{id}/features` | read |
| [`sites.setCnamePrefix`](#sitessetcnameprefix) | `PUT /sites/{id}/cname-prefix` | write |
| [`sites.starred`](#sitesstarred) | `GET /starred-sites` | read |
| [`sites.setStarred`](#sitessetstarred) | `PUT /sites/{id}/starred` | write |

### `sites.list`

`GET /sites` · read · service account `sites:read`

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `search` | query | string | no | At most 100 after trimming | Matches the site name, any domain or any tag name (substring, case-insensitive); a Unicode term also matches by Punycode and by the decoded name |
| `clusterId` | query | uuid | no | — | Only sites of this cluster; an unknown cluster gives an empty result |
| `tagIds` | query | `array<uuid>` | no | At most 10; `tagIds[]=a&tagIds[]=b`, one value also as `tagIds=a` | Only sites with these tags |
| `tagMatch` | query | enum | no | `any` / `all`, `any` when omitted | `any`: any of the tags; `all`: every tag |
| `page` | query | integer | no | ≥1, default `1` | Page |
| `pageSize` | query | integer | no | 1–100, default `20` | Items per page |

Response: `{ items: [Site](#site-object)[], total }`, oldest first; `total` counts every matching site.

### `sites.get`

`GET /sites/{id}` · read · service account `sites:read`

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |

Response: [Site](#site-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `sites.create`

`POST /sites` · write · `201`

The body is a [site input](#site-input). A new site has no certificate and gets a random 8-character CNAME prefix.

Response: [Site mutation result](#site-mutation-result) (without `certificateReissue`).

| Error | Status | Condition |
| --- | --- | --- |
| `NO_CLUSTER` | 412 | `clusterId` omitted and no cluster exists yet |
| `CLUSTER_NOT_FOUND` | 404 | `clusterId` does not exist |
| `DOMAIN_INVALID` | 400 | A host name UTS #46 refuses, or more than 10 pattern domains; `data.domain` |
| `DOMAIN_IN_USE` | 409 | A domain belongs to another site; `data.domains` |
| `SITE_PORT_UNAVAILABLE` | 400 | A port is not 80, 443 or an extra listener port of the cluster; `data.port` |
| `SITE_HTTPS_PORT_NEEDS_CERTIFICATE` | 400 | `ports.https` has a port other than 443 (a new site has no certificate); `data.port` |
| `SITE_PORTS_EMPTY` | 400 | `ports.http` is empty |
| `ORIGIN_HOST_HEADER_INVALID` | 400 | An origin's `hostHeader` is not a host name or IP nodes accept; `data.hostHeader` |
| `ORIGIN_ADDRESS_FORBIDDEN` | 400 | An origin address is a special-purpose IP the platform does not allow, or localhost; `data.address`, `data.range` |
| `ORIGIN_PROXY_PROTOCOL_S3` | 400 | An S3 origin has `proxyProtocolVersion` other than 0 |
| `S3_SECRET_REQUIRED` | 400 | An S3 origin lacks `secretAccessKey`; `data.accessKeyId` |
| `ORIGIN_GRPC_REQUIRES_HTTP2` | 400 | `originSettings.grpc` is `true` and `protocol` is not `http2` |
| `ORIGIN_TLS_TRUST_REQUIRES_VERIFY` | 400 | `tlsTrust` is `originCa` and `tlsVerify` is `false` |
| `ORIGIN_CA_S3` | 400 | `tlsTrust` is `originCa` and an origin is S3 |
| `ORIGIN_CA_NOT_FOUND` | 409 | `tlsTrust` is `originCa` and the Origin CA has not been created |
| `ORIGIN_CLIENT_CA_NOT_FOUND` | 409 | `originSettings.clientCertificate` is `true` and the origin client CA has not been created |
| `PURGE_KEY_REQUIRED` | 400 | The PURGE method is enabled without a `key` |
| `CACHE_RULE_PRIORITY_DUPLICATE` | 400 | Two cache rules share a `priority`; `data.priority` |
| `RULE_INVALID` | 400 | A cache rule's condition does not compile |
| `CLUSTER_SITE_LIMIT` | 409 | More than 512 enabled sites in the cluster; `data.limit` |

### `sites.update`

`PATCH /sites/{id}` · write

Changes only the fields present in the request; field details in [site input](#site-input).

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `name` | body | string | no | 1–100 after trimming; unchanged when omitted | Name |
| `domains` | body | `array<string>` | no | As in [site input](#site-input); unchanged when omitted | Replaces the domains. Domains the HTTPS redirect leaves alone that the site no longer has are dropped |
| `origins` | body | array<[Origin input](#origin-input)> | no | As in [site input](#site-input); unchanged when omitted | Replaces the origins. An origin with the same scheme, address and port keeps its ID |
| `cacheRules` | body | array<[Cache rule input](#cache-rule-input)> | no | At most 64; unchanged when omitted | Replaces the cache rules; an unchanged rule keeps its ID |
| `originSettings` | body | [Origin pool settings](#origin-pool-settings) | no | Unchanged when omitted | Replaced as a whole: omitted fields take their defaults, except `activeHealthCheck`, `sessionAffinity`, `protocol`, `grpc`, `tries`, `statusRetry`, `tlsTrust` and `clientCertificate`, which stay as they are |
| `cacheSettings` | body | [Cache settings](#cache-settings) | no | Unchanged when omitted | Replaced as a whole: omitted fields take their defaults, except `keepCacheTag`, `xCache` and `purgeMethod`, which stay as they are |
| `contentSettings` | body | [Content settings](#content-settings) | no | Unchanged when omitted | Replaced as a whole: omitted fields take their defaults, except `rulesBodyLimit`, which stays as it is |
| `ports` | body | object | no | As in [site input](#site-input); unchanged when omitted | Replaces the listener ports; the HTTPS redirect's `redirectPort` must be 443 or one of the HTTPS ports |

When `domains` changes and the site's first certificate is an auto-renewing ACME certificate, the certificate takes the new domains and is reissued at once, and the response carries `certificateReissue`; any other certificate must cover every domain.

Response: [Site mutation result](#site-mutation-result).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |
| `DOMAIN_INVALID` | 400 | As for `sites.create` |
| `DOMAIN_IN_USE` | 409 | As for `sites.create` |
| `CERTIFICATE_DOMAIN_MISMATCH` | 400 | The site's certificate does not cover a new domain and cannot be extended; `data.domains` |
| `CERTIFICATE_BUSY` | 409 | A certificate request for the site is already running |
| `SITE_PORT_UNAVAILABLE` | 400 | As for `sites.create` |
| `SITE_HTTPS_PORT_NEEDS_CERTIFICATE` | 400 | The site has no certificate and `ports.https` has a port other than 443; `data.port` |
| `SITE_PORTS_EMPTY` | 400 | The site would be served on no port |
| `HTTPS_REDIRECT_PORT_INVALID` | 400 | The HTTPS redirect port is not in the new `ports.https`; `data.port` |
| `ORIGIN_HOST_HEADER_INVALID`, `ORIGIN_ADDRESS_FORBIDDEN`, `ORIGIN_PROXY_PROTOCOL_S3`, `S3_SECRET_REQUIRED` | 400 | As for `sites.create` |
| `ORIGIN_GRPC_REQUIRES_HTTP2` | 400 | The resulting `grpc` is `true` and `protocol` is not `http2` |
| `ORIGIN_TLS_TRUST_REQUIRES_VERIFY`, `ORIGIN_CA_S3` | 400 | As for `sites.create`, checked on the resulting settings and origins |
| `ORIGIN_CA_NOT_FOUND`, `ORIGIN_CLIENT_CA_NOT_FOUND` | 409 | As for `sites.create` |
| `PURGE_KEY_REQUIRED` | 400 | The PURGE method is enabled with neither a stored key nor a `key` |
| `CACHE_RULE_PRIORITY_DUPLICATE` | 400 | As for `sites.create` |
| `RULE_INVALID` | 400 | A cache rule's condition does not compile, or the new origins drop an origin group a rule uses |

### `sites.delete`

`DELETE /sites/{id}` · write

Deletes the site with its settings; the usage of windows not computed yet is computed first; alert subscriptions left without any site are deleted.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |

Response: `{ revision: [Revision](#revision-object) }`.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `sites.launch`

`GET /sites/{id}/launch` · read · service account `sites:read`

Looks up every domain of the site now (in parallel, up to a few seconds) and reports certificate coverage and delivery. Behaviour: [Launch check](../../guide/site-management.en.md#launch-check).

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |

Response: [Launch check](#launch-check-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `sites.originHealth`

`GET /sites/{id}/origin-health` · read

Health of the site's origins as the nodes report it (passive and active checks).

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |

Response: [Origin health](#origin-health-object)`[]`.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `sites.originQuality`

`GET /sites/{id}/origins/quality` · read

Fetches from each origin over a range, with failures and time to the response header (node capability `origin-stats-v1`). Behaviour: [Origin quality](../../guide/origins-and-cache.en.md#origin-quality).

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `range` | query | enum | no | `1h` / `6h` / `24h` / `7d` / `30d`, default `24h` | Range |

Response: [Origin quality](#origin-quality-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `sites.features`

`GET /sites/{id}/features` · read

Whether each feature can be turned on for the site now: available when every active node of its cluster reports the node capability.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |

Response: [Site features](#site-features-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `sites.setCnamePrefix`

`PUT /sites/{id}/cname-prefix` · write

Sets the first label of the site's CNAME target `<prefix>.<cluster domain>`; without `prefix`, a new random one. The replaced prefix keeps resolving for 24 hours (unless the automatic DNS never published it). Publishes the cluster's DNS revision (reason `cname`), no configuration revision; audits `site.cname_update`. Behaviour: [CNAME prefixes](../../guide/domains.en.md#cname-prefixes).

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `prefix` | body | string | no | After trimming and lowercasing 1–30 of `[a-z0-9-]`, not starting or ending with `-`; or a UUID | The new prefix. A UUID is accepted only as the site's own ID prefix from before CNAME prefixes while it still resolves: its current prefix (no change) or a replaced one still in its 24-hour transition (taking it back) |

Response: `{ prefix, retired: [{ prefix, expiresAt }] }`: the current prefix and the replaced ones still in transition (`expiresAt` is a datetime).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |
| `CNAME_PREFIX_INVALID` | 400 | A UUID that is not a prefix of the site still resolving; `data.prefix` |
| `CNAME_PREFIX_CONFLICT` | 409 | The prefix is used by a site or layer-4 application (replaced prefixes in transition included), is `all`, `all-<n>` or a record name of a DNS binding, or the automatic DNS zone already holds a record at that name the cluster does not manage; `data.prefix` |

### `sites.starred`

`GET /starred-sites` · read

The sites the caller (the signed-in user or the AccessKey's user) starred.

No parameters.

Response: `[{ id, name, domains }]`, most recently starred first; `domains` is `array<string>`.

### `sites.setStarred`

`PUT /sites/{id}/starred` · write

Stars or un-stars the site for the caller; not audited, not published.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `starred` | body | boolean | yes | — | `true` stars, `false` un-stars |

Response: `{ ok: true }`.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

## Enabling and disabling sites

- A disabled site is not shipped to nodes; its DNS records stay. Purge and prefetch tasks for a disabled site return 409 `SITE_DISABLED`.
- A change of state publishes a revision and writes the audit entry: for one site `site_enabled` / `site_disabled`, `site.enable` / `site.disable`.
- Enabling a site while usage protection holds `disable` as its action lifts that action and pauses usage protection until the end of its period (see [Usage protection](#usage-protection)).
- Behaviour: [Site enabling](../../guide/clusters.en.md#site-enabling).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`sites.setEnabled`](#sitessetenabled) | `PUT /sites/{id}/enabled` | write; service account `sites:write` |
| [`sites.batchSetEnabled`](#sitesbatchsetenabled) | `POST /sites/batch/enabled` | write |

### `sites.setEnabled`

`PUT /sites/{id}/enabled` · write · service account `sites:write`

When the site already has the requested state, returns the site and its cluster's latest revision without comparing `expectedUpdatedAt`, creating a revision or writing an audit entry.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `enabled` | body | boolean | yes | — | `true` enables, `false` disables |
| `expectedUpdatedAt` | body | datetime | no | — | The site's `updatedAt` the caller read |

Response: [Site mutation result](#site-mutation-result) (without `certificateReissue`); `site.enabled` is the current state.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |
| `UPDATED_AT_MISMATCH` | 409 | `expectedUpdatedAt` differs from the site's current `updatedAt`; `data.updatedAt` |
| `CLUSTER_SITE_LIMIT` | 409 | Enabling would leave more than 512 enabled sites in the cluster; `data.limit` |
| `NODE_CAPABILITY_REQUIRED` | 409 | A service account calls and the configuration needs a capability an active node of the cluster lacks; `data.features`, `data.nodes` |

### `sites.batchSetEnabled`

`POST /sites/batch/enabled` · write

Enables or disables several sites in one transaction. Sites already in the state stay as they are and are not audited; every other site gets an audit entry (metadata `batch`: the number of sites requested), and each cluster is published once (reason `sites_enabled` / `sites_disabled` with `count`; `site_enabled` / `site_disabled` when one site of the cluster changed).

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `ids` | body | `array<uuid>` | yes | 1–100, repeats dropped | Site IDs |
| `enabled` | body | boolean | yes | — | Target state |

Response: [Batch result](#batch-result).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | A site does not exist; nothing changes |
| `CLUSTER_SITE_LIMIT` | 409 | Enabling would leave more than 512 enabled sites in a cluster; `data.limit` |

## Site tags and batch operations

- Tags are the console's own: nothing is published. A tag name is 1–32 characters after trimming and NFC normalization (at most 256 as sent), without control characters; names compare case-insensitively, a name matching an existing tag keeps that tag's spelling, a new name creates a tag. A site carries at most 10 tags.
- A change of a site's tags is audited as `site.tags_update` (metadata `added`, `removed`, `tags`); renaming as `site_tag.rename`, deleting as `site_tag.delete`.
- Batch operations change all sites or none. Behaviour: [Tags](../../guide/site-management.en.md#tags) and [Batch actions](../../guide/site-management.en.md#batch-actions); purging several sites is [`cacheTasks.create`](#cachetaskscreate) with `type` `site`.

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`sites.setTags`](#sitessettags) | `PUT /sites/{id}/tags` | write |
| [`siteTags.list`](#sitetagslist) | `GET /site-tags` | read |
| [`siteTags.rename`](#sitetagsrename) | `PATCH /site-tags/{id}` | write |
| [`siteTags.delete`](#sitetagsdelete) | `DELETE /site-tags/{id}` | write |
| [`sites.batchTags`](#sitesbatchtags) | `POST /sites/batch/tags` | write |
| [`sites.batchDelete`](#sitesbatchdelete) | `POST /sites/batch/delete` | write |

### `sites.setTags`

`PUT /sites/{id}/tags` · write

Replaces the site's tags.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `tags` | body | `array<string>` | yes | At most 10; case-insensitive repeats dropped | Tag names |

Response: `{ tags: [{ id, name }] }`.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `siteTags.list`

`GET /site-tags` · read

No parameters.

Response: `[{ id, name, sites }]` by name (case-insensitive), tags without sites included; `sites` is the number of sites with the tag.

### `siteTags.rename`

`PATCH /site-tags/{id}` · write

Renames the tag on every site. A name another tag has (any case) merges the two: the sites with this tag get that tag, which takes the name as given, and this one is deleted.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Tag ID |
| `name` | body | string | yes | Tag name rules | New name |

Response: `{ id, name, sites }`; after a merge, the merged tag.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_TAG_NOT_FOUND` | 404 | The tag does not exist |

### `siteTags.delete`

`DELETE /site-tags/{id}` · write

Takes the tag off every site and deletes it; audit metadata `sites` is the number of sites affected.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Tag ID |

Response: `{ ok: true }`.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_TAG_NOT_FOUND` | 404 | The tag does not exist |

### `sites.batchTags`

`POST /sites/batch/tags` · write

Adds and removes tags on several sites.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `ids` | body | `array<uuid>` | yes | 1–100, repeats dropped | Site IDs |
| `add` | body | `array<string>` | no | At most 10, default `[]` | Tag names to add |
| `remove` | body | `array<string>` | no | At most 10, default `[]` | Tag names to remove |

At least one of `add` and `remove` is non-empty; a name (any case) cannot be in both.

Response: [Batch result](#batch-result); `changed` lists the sites whose tags changed, `revisions` is `[]`.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | A site does not exist |
| `SITE_TAG_LIMIT` | 400 | A site would carry more than 10 tags; `data.site`, `data.limit` |

### `sites.batchDelete`

`POST /sites/batch/delete` · write

Deletes several sites as `sites.delete` does; each site is audited as `site.delete` (metadata `batch`) and each cluster is published once (reason `sites_deleted` with `count`; `site_deleted` for a cluster with one site).

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `ids` | body | `array<uuid>` | yes | 1–100, repeats dropped | Site IDs |

Response: [Batch result](#batch-result).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | A site does not exist |

## Copying settings and cloning

- Values of `parts`: `cacheRules`, `cacheKey` (cache key and slicing), `cacheTag`, `compression`, `https` (the HTTPS options without the certificates and the domains the redirect leaves alone), `rules` (with `rulesBodyLimit`), `bulkRedirects`, `errorPages`, `waf`, `protection` (Under Attack, CC policy and challenge settings), `accessControl`, `authRules` (secrets sealed anew for the target), `originSettings` (origin pool settings without the origins), `logs` (sample rate, log options and JA4 logging), `imageConvert`, `markdown` (Markdown for Agents), `aiCrawl` (AI crawl control: crawler actions, the managed robots.txt, pay per crawl). A copied part replaces the target's part as a whole; a part equal to the target's is not written.
- The change of a list part (`cacheRules`, `rules`, `bulkRedirects`, `errorPages`, `authRules`) is told as item counts before and after, of any other part as the number of settings that change.
- A target that lacks what the settings name fails, for example: an origin group a rule chooses `ORIGIN_GROUP_UNKNOWN`, the HTTPS redirect / HSTS / client certificates copied to a target without a certificate `HTTPS_REQUIRES_CERTIFICATE`, a redirect port that is not an HTTPS port of the target `HTTPS_REDIRECT_PORT_INVALID`, client certificates together with HTTP/3 `CLIENT_CERTIFICATE_HTTP3`, a bulk redirect source host that is not a domain of the target `BULK_REDIRECT_HOST_UNKNOWN`, an access authentication scope domain that is not a domain of the target `AUTH_DOMAIN_UNKNOWN`, a missing IP list `IP_LIST_NOT_FOUND`.
- Behaviour: [Copying settings](../../guide/site-management.en.md#copying-settings) and [Cloning a site](../../guide/site-management.en.md#cloning-a-site).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`sites.copySettingsPreview`](#sitescopysettingspreview) | `GET /sites/{id}/copy-settings` | read |
| [`sites.copySettings`](#sitescopysettings) | `POST /sites/{id}/copy-settings` | write |
| [`sites.clone`](#sitesclone) | `POST /sites/{id}/clone` | write |

### `sites.copySettingsPreview`

`GET /sites/{id}/copy-settings` · read

Runs the copy on each target and rolls it back: nothing is saved, published or audited.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Source site ID |
| `targetIds` | query | `array<uuid>` | yes | 1–100, repeats dropped, not `id`; `targetIds[]=a&targetIds[]=b` | Target sites |
| `parts` | query | `array<enum>` | yes | 1–15, values above; `parts[]=a&parts[]=b` | Parts to copy |

Response: [Copy preview](#copy-preview-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The source site does not exist (a missing target only gets `error` `SITE_NOT_FOUND`) |

### `sites.copySettings`

`POST /sites/{id}/copy-settings` · write

Copies parts of the source's settings to each target, one transaction per target: a failed target keeps its settings, the others are saved. Each target that succeeds publishes its cluster (reason `site_settings_copied` with `site`, `source`) and is audited as `site.settings_copied` (metadata `source`, `parts`, `changed`, `revision`).

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Source site ID |
| `targetIds` | body | `array<uuid>` | yes | 1–100, repeats dropped, not `id` | Target sites |
| `parts` | body | `array<enum>` | yes | 1–15, values above, applied in the order listed there | Parts to copy |

Response: [Copy result](#copy-result-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The source site does not exist (a missing target only fails itself) |

### `sites.clone`

`POST /sites/{id}/clone` · write · `201`

Creates a site in the source's cluster with every copyable part of the source, its origins (S3 credentials sealed anew), PURGE method and key, content settings, maintenance mode and tags. Certificates stay behind; the settings that need one (HTTPS redirect, HSTS, client certificates, HTTPS ports other than 443) and the domains the redirect leaves alone are turned off or dropped. Publishes (reason `site_cloned` with `site`, `source`) and audits `site.clone`.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Source site ID |
| `name` | body | string | no | 1–100 after trimming; the first 100 characters of the first domain when omitted | Name of the new site |
| `domains` | body | `array<string>` | yes | As `domains` in [site input](#site-input) | Domains of the new site |
| `tags` | body | `array<string>` | no | At most 10; the source's tags when omitted | Tag names |

Response: [Site mutation result](#site-mutation-result) (without `certificateReissue`).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The source site does not exist |
| `DOMAIN_INVALID` | 400 | As for `sites.create` |
| `DOMAIN_IN_USE` | 409 | As for `sites.create` |
| `ORIGIN_ADDRESS_FORBIDDEN` | 400 | An origin address of the source is no longer allowed by the platform |
| `AUTH_DOMAIN_UNKNOWN`, `BULK_REDIRECT_HOST_UNKNOWN`, `ORIGIN_GROUP_UNKNOWN` | 400 | A copied setting names a domain or origin group the new site does not have |
| `CLUSTER_SITE_LIMIT` | 409 | More than 512 enabled sites in the cluster; `data.limit` |

## Cache tasks

- Task types: `url`, `prefix`, `site`, `host` and `tag` purge, `prefetch` and `sitemap` prefetch. `host` and `tag` need node capability `purge-tag-v1`, `sitemap` and prefetching the `mobile` variant need `prefetch-v2`; when an active node of a cluster involved lacks it, every caller gets 409 `NODE_CAPABILITY_REQUIRED`.
- A task goes to every node of the clusters involved; disabled nodes are recorded as `skipped`. Tasks publish no revision; they are audited as `cache.purge` or `cache.prefetch`.
- Behaviour: [Purge and prefetch](../../guide/origins-and-cache.en.md#purge-and-prefetch).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`sites.purgeAll`](#sitespurgeall) | `POST /sites/{id}/purge` | write |
| [`cacheTasks.list`](#cachetaskslist) | `GET /cache-tasks` | read |
| [`cacheTasks.get`](#cachetasksget) | `GET /cache-tasks/{id}` | read |
| [`cacheTasks.create`](#cachetaskscreate) | `POST /cache-tasks` | write |

### `sites.purgeAll`

`POST /sites/{id}/purge` · write

Purges the whole site: the same as `cacheTasks.create` with `{"type":"site","siteIds":["<id>"]}`, but with status 200.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |

Response: [Cache task](#cache-task-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |
| `SITE_DISABLED` | 409 | The site is disabled |

### `cacheTasks.list`

`GET /cache-tasks` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `siteId` | query | uuid | no | — | Only tasks involving this site |
| `page` | query | integer | no | ≥1, default `1` | Page |
| `pageSize` | query | integer | no | 1–100, default `20` | Items per page |

Response: `{ items: [Cache task](#cache-task-object)[], total }`, newest first.

### `cacheTasks.get`

`GET /cache-tasks/{id}` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Task ID |

Response: [Cache task](#cache-task-object).

| Error | Status | Condition |
| --- | --- | --- |
| `CACHE_TASK_NOT_FOUND` | 404 | The task does not exist |

### `cacheTasks.create`

`POST /cache-tasks` · write · `201`

Purges find sites as the nodes route: in each cluster, among its enabled sites, by domain precedence; when several clusters serve a host, the task includes each cluster's site. Prefetch and sitemap tasks go to one cluster: that of the site that comes first by the same precedence among the sites of every cluster.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `type` | body | enum | yes | `url` / `prefix` / `site` / `prefetch` / `host` / `tag` / `sitemap` | Task type |
| `urls` | body | `array<string>` | no | At most 500, each 1–2048 after trimming, default `[]`; at least one for `url`, `prefix`, `prefetch`, exactly one for `sitemap` | Absolute `http(s)` URLs (no credentials; the host a host name). `url`, `prefetch`: URLs; `prefix`: URL prefixes (no query string); `sitemap`: the sitemap URL. The fragment is dropped |
| `siteIds` | body | `array<uuid>` | no | At most 100, default `[]`; at least one for `site`, `tag` | `site`: sites purged entirely; `tag`: sites purged by tag |
| `hosts` | body | `array<string>` | no | At most 500, each 1–253 after trimming, default `[]`; at least one for `host` | `host`: every URL of these host names is purged; no port or wildcard, lowercased, trailing dot dropped |
| `tags` | body | `array<string>` | no | At most 500, each at most 1024, default `[]`; at least one for `tag` | `tag`: Cache-Tag values; after trimming and lowercasing ASCII letters 1–128 bytes of printable ASCII without commas |
| `variants` | body | `array<enum>` | no | `desktop` / `mobile`, 1–2, default `["desktop"]` | `prefetch`, `sitemap`: device variants prefetched; `mobile` only differs for cache keys with the device type |
| `maxUrls` | body | integer | no | 1–10000, default `1000` | `sitemap`: URLs prefetched at most (each in every variant) |

Response: [Cache task](#cache-task-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | A site of `siteIds` does not exist |
| `SITE_DISABLED` | 409 | A site the task involves is disabled |
| `CACHE_TASK_URL_INVALID` | 400 | A URL is not an absolute `http(s)` URL, has credentials or a host that is not a host name, or a prefix has a query string; `data.urls` (first 5) |
| `CACHE_TASK_HOST_INVALID` | 400 | A host has a port or a wildcard, or is invalid; `data.hosts` |
| `CACHE_TASK_TAG_INVALID` | 400 | A tag breaks the rules; `data.tags` |
| `CACHE_TASK_HOST_UNKNOWN` | 400 | The host of a URL or of `hosts` belongs to no site; `data.hosts` |
| `NODE_CAPABILITY_REQUIRED` | 409 | An active node of a cluster involved lacks `purge-tag-v1` or `prefetch-v2`; `data.features`, `data.nodes` |

## HTTPS

- `https.update` publishes the site's cluster (reason `certificate_updated`) and audits `site.https_update`.
- Uploading, requesting and renewing certificates: [API: Certificates](certificates.en.md); behaviour: [Configure a site's HTTPS](../../guide/https.en.md#configure-a-sites-https), [Enable HTTPS with one click](../../guide/https.en.md#enable-https-with-one-click) and [Compression](../../guide/https.en.md#compression).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`https.get`](#httpsget) | `GET /sites/{id}/https` | read |
| [`https.update`](#httpsupdate) | `PUT /sites/{id}/https` | write |
| [`https.check`](#httpscheck) | `GET /sites/{id}/https/check` | read |

### `https.get`

`GET /sites/{id}/https` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |

Response: [HTTPS settings](#https-settings).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `https.update`

`PUT /sites/{id}/https` · write

Replaces the site's certificates, HTTPS and compression settings; omitted fields take their defaults. With `certificateId` `null`, `redirectPort` becomes 443, `additionalCertificateIds` is emptied and `clientCertificate.mode` becomes `off`.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `settings` | body | [HTTPS settings](#https-settings) | yes | — | New settings |

Response: the saved [HTTPS settings](#https-settings).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |
| `CERTIFICATE_NOT_FOUND` | 404 | A certificate does not exist |
| `CERTIFICATE_UNAVAILABLE` | 409 | A certificate is not issued yet or expired |
| `CERTIFICATE_CHAIN_EXPLICIT_CURVE`, `CERTIFICATE_KEY_EXPLICIT_CURVE` | 400 | Nodes cannot load the certificate (an EC key without a named curve) |
| `CERTIFICATE_DOMAIN_MISMATCH` | 400 | A domain of the site is covered by none of the certificates; `data.domains` |
| `CLIENT_CERTIFICATE_HTTP3` | 400 | Client certificates and `http3` are both on |
| `CLIENT_CA_INVALID` | 400 | `clientCertificate.caPem` is not 1 to 10 current CA certificates |
| `HTTPS_REDIRECT_PORT_INVALID` | 400 | `redirectPort` is neither 443 nor an HTTPS port of the site; `data.port` |
| `HTTPS_REDIRECT_DOMAIN_INVALID` | 400 | `redirectExcludedDomains` has a domain the site does not have; `data.domains` |
| `SITE_PORTS_EMPTY` | 400 | Without the certificate the site would be served on no port |

### `https.check`

`GET /sites/{id}/https/check` · read

The certificate request one-click HTTPS would send and everything that stops it. Saves nothing.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `ca` | query | enum | no | `letsencrypt` / `zerossl` / `google` / `custom`; `defaultCa` of `certificates.settings` when omitted | The CA whose CAA permission is checked |

Response:

| Field | Type | Description |
| --- | --- | --- |
| `request.name` | string | Certificate name (the site name) |
| `request.names` | `array<string>` | Names requested: the site's domains, `.a.com` as `*.a.com`, pattern domains left out |
| `request.email` | string | E-mail of the last ACME account or request, else the operator's |
| `request.challenge` | enum | `http01`; `dns01` when the site has a wildcard or suffix domain |
| `request.dnsCredentialId` | uuid | For `dns01`, the first DNS credential whose zone covers every name, or `null` |
| `blockers` | `array<object>` | Every blocker, each a `code` with parameters: `nodes_offline` (`cluster`: no online active node), `nodes_lack_http01` (`nodes`: online nodes without `http01-v1`), `dns_not_pointing` (`name`, `pointing`: `unresolved` / `elsewhere`), `dns_credential_missing` (`names`), `dns_credential_failed` (`credential`, `error`: an API error code), `caa_forbidden` (`name`), `no_certificate_names` (the site has only pattern domains) |
| `certificates` | `array<object>` | Issued, unexpired certificates covering every domain of the site, `{ id, name }` |

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

## Error pages and maintenance mode

- `errorPages.update` publishes the site's cluster (reason `site_error_pages_updated`) and audits `site.error_pages_update`; `maintenance.update` publishes (reason `site_maintenance_updated`) and audits `site.maintenance_update`. Audit entries keep statuses and template sizes, not the templates.
- Node capabilities: template pages for 403, 429, 502, 503 and 504 need `error-pages-v1`; other statuses, `4xx` / `5xx`, redirect pages, `responseStatus` and maintenance mode need `site-content-v1`; templates with `{{time}}` or `{{path}}` need `rules-v3`.
- The platform's pages (unknown hosts, disabled sites) are system settings (`settings.errorPages`, `settings.setErrorPages`). Behaviour: [Error pages](../../guide/error-pages.en.md) and [Maintenance mode](../../guide/error-pages.en.md#maintenance-mode).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`errorPages.get`](#errorpagesget) | `GET /sites/{id}/error-pages` | read |
| [`errorPages.update`](#errorpagesupdate) | `PUT /sites/{id}/error-pages` | write |
| [`maintenance.get`](#maintenanceget) | `GET /sites/{id}/maintenance` | read |
| [`maintenance.update`](#maintenanceupdate) | `PUT /sites/{id}/maintenance` | write |

### `errorPages.get`

`GET /sites/{id}/error-pages` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |

Response: [Error pages](#error-pages-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `errorPages.update`

`PUT /sites/{id}/error-pages` · write

Replaces the site's error pages; a status without a page uses the nodes' built-in page.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `pages` | body | `array<object>` | yes | At most 13, at most one per status | Pages |
| `pages[].status` | body | integer or enum | yes | 400, 401, 403, 404, 405, 410, 429, 500, 502, 503, 504, or `"4xx"` / `"5xx"` | Status; `4xx` / `5xx` serve the statuses of the class without a page of their own |
| `pages[].template` | body | string | no | Default `""`; at most 65536 bytes (UTF-8) | HTML template; either this or `redirectUrl` |
| `pages[].redirectUrl` | body | string | no | Trimmed, default `""`; 1–2048 printable ASCII characters without spaces | Target of a 302: an absolute `http(s)` URL without credentials, or a path starting with a single `/`; the only placeholders are `{{status}}` and `{{request_id}}` (not in the host or port), every `%` starts an escape of two hex digits |
| `pages[].responseStatus` | body | integer | no | 0 or 200–599, default `0` | Status a template page is sent with, 0 keeps the response's; must be 0 for a redirect page |
| `interceptOriginErrors` | body | boolean | no | Default `false` | Also replace origin responses whose status has a page |
| `expectedUpdatedAt` | body | datetime | no | — | The `updatedAt` the caller read |

Response: [Error pages](#error-pages-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |
| `ERROR_PAGE_TOO_LARGE` | 400 | A template is over 65536 bytes; `data.status`, `data.limit` |
| `UPDATED_AT_MISMATCH` | 409 | `expectedUpdatedAt` differs; `data.updatedAt` |

### `maintenance.get`

`GET /sites/{id}/maintenance` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |

Response: [Maintenance](#maintenance-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `maintenance.update`

`PUT /sites/{id}/maintenance` · write

Replaces the maintenance settings; they are kept while off. While on, nodes answer the site's requests with 503 (except requests from `allowedCidrs`, to paths under `allowedPathPrefixes` and HTTP-01 requests for the origin) and serve nothing from the cache. Turning maintenance off while usage protection holds `maintenance` as its action lifts that action and pauses usage protection until the end of its period.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `enabled` | body | boolean | yes | — | Maintenance mode on |
| `template` | body | string | no | Default `""`; at most 65536 bytes (UTF-8) | Page template with the error page placeholders; empty uses the nodes' built-in maintenance page |
| `retryAfterSeconds` | body | integer | no | 0–86400, default `0` | `Retry-After` in seconds, 0 sends none |
| `allowedCidrs` | body | `array<string>` | no | At most 64, each at most 64 after trimming, default `[]` | Addresses or CIDRs let through; host bits cleared, IPv4-mapped addresses stored as IPv4, mapped prefixes shorter than /96 refused; repeats dropped |
| `allowedPathPrefixes` | body | `array<string>` | no | At most 32, default `[]`; start with `/`, no whitespace, `?`, `#` or control characters, at most 1024 bytes (UTF-8) | Path prefixes let through; repeats dropped |
| `expectedUpdatedAt` | body | datetime | no | — | The `updatedAt` the caller read |

Response: [Maintenance](#maintenance-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |
| `ERROR_PAGE_TOO_LARGE` | 400 | The template is over 65536 bytes; `data.status` 503, `data.limit` |
| `UPDATED_AT_MISMATCH` | 409 | `expectedUpdatedAt` differs; `data.updatedAt` |

## Access authentication

- Rules match in array order: a request is checked by the first enabled rule whose scope it matches, before the rule phases and the cache lookup. Basic password hashes and URL signing keys are write-only; responses tell only whether they are set.
- `authRules.update` and `authRules.forgetIdentityHeaders` publish the site's cluster (reason `site_auth_updated`) and audit `site.auth_update`, `site.auth_identity_forget`; `authRules.signUrl` audits `site.auth_sign_url` (rule, path and expiry, never the signature). Audit entries carry no secret.
- With an enabled rule the configuration needs node capability `access-auth-v1`. Behaviour: [Access control](../../guide/access-control.en.md).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`authRules.get`](#authrulesget) | `GET /sites/{id}/auth-rules` | read |
| [`authRules.update`](#authrulesupdate) | `PUT /sites/{id}/auth-rules` | write |
| [`authRules.forgetIdentityHeaders`](#authrulesforgetidentityheaders) | `POST /sites/{id}/auth-rules/forget-identity-headers` | write |
| [`authRules.signUrl`](#authrulessignurl) | `POST /sites/{id}/auth-rules/{ruleId}/sign` | write |
| [`authRules.failures`](#authrulesfailures) | `GET /sites/{id}/auth-rules/failures` | read |

### `authRules.get`

`GET /sites/{id}/auth-rules` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |

Response: [Access authentication](#access-authentication-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `authRules.update`

`PUT /sites/{id}/auth-rules` · write

Replaces the site's rules. A rule with an `id` keeps the stored passwords and keys the input leaves out; a rule whose secret changes gets a new secret version.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `rules` | body | array<[Access authentication rule input](#access-authentication-rule-input)> | yes | At most 16 | Rules, matched in order |
| `expectedUpdatedAt` | body | datetime | no | — | The `updatedAt` the caller read |

Response: [Access authentication](#access-authentication-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |
| `UPDATED_AT_MISMATCH` | 409 | `expectedUpdatedAt` differs; `data.updatedAt` |
| `AUTH_RULE_NOT_FOUND` | 404 | A rule `id` is not the site's, or repeats |
| `AUTH_DOMAIN_UNKNOWN` | 400 | `scope.domains` has a domain the site does not have; `data.domain` |
| `ORIGIN_ADDRESS_FORBIDDEN` | 400 | The host of a forward authentication service is a special-purpose address the platform does not allow; `data.address`, `data.range` |
| `AUTH_PASSWORD_REQUIRED` | 400 | A new Basic user without `password`; `data.user` |
| `AUTH_KEY_REQUIRED` | 400 | A URL rule without `primaryKey` and without a stored primary key |

### `authRules.forgetIdentityHeaders`

`POST /sites/{id}/auth-rules/forget-identity-headers` · write

Nodes stop removing these identity headers of former rules (names in `formerIdentityHeaders`; names a current rule, disabled ones included, sets are left alone). With no name to forget nothing is published or audited and the current state is returned.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `names` | body | `array<string>` | yes | 1–64; lowercased 1–64 token characters, not a protected header, not starting with `x-edgeweir-` | Header names |
| `expectedUpdatedAt` | body | datetime | no | — | The `updatedAt` the caller read |

Response: [Access authentication](#access-authentication-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |
| `UPDATED_AT_MISMATCH` | 409 | `expectedUpdatedAt` differs; `data.updatedAt` |

### `authRules.signUrl`

`POST /sites/{id}/auth-rules/{ruleId}/sign` · write · no `Idempotency-Key`

Signs with the primary key of a URL authentication rule; computed by the console, neither stored nor sent to nodes.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `ruleId` | path | uuid | yes | — | Rule ID |
| `url` | body | string | yes | 1–4096 after trimming | A path starting with a single `/`, or an `http(s)` URL whose host is a domain of the site (no credentials) |
| `validitySeconds` | body | integer | no | 1–31536000; the rule's `validitySeconds` by default | Validity, at most the rule's |

Response: `{ url, expiresAt }`: the signed URL (with scheme and host when a full URL was given) and its expiry (datetime).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |
| `AUTH_RULE_NOT_FOUND` | 404 | The rule is not the site's |
| `AUTH_RULE_NOT_URL` | 400 | The rule is not URL authentication (`url_a`–`url_d`) |
| `AUTH_KEY_REQUIRED` | 400 | The rule has no primary key |
| `AUTH_SIGN_VALIDITY` | 400 | `validitySeconds` is longer than the rule's validity; `data.max` |
| `AUTH_SIGN_URL_INVALID` | 400 | `url` is neither a path nor an `http(s)` URL of the site's domains |

### `authRules.failures`

`GET /sites/{id}/auth-rules/failures` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `range` | query | enum | no | `1h` / `6h` / `24h` / `7d` / `30d`, default `24h` | Range |

Response: `{ requests, unsupportedNodes }`: requests access authentication refused over the range (number), and the active nodes of the cluster that do not count them (integer, no `access-auth-v1`).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

## Access control

- Site lists, hotlink protection, user agents, CORS, geo, WebSocket origins and idle timeout, security headers and encoded path exceptions. Each part keeps its settings while off; a site that never saved them reads as the defaults.
- `accessControl.update` publishes the site's cluster (reason `site_access_control_updated`) and audits `site.access_control_update` (metadata `parts` and each part's switches and counts, never the lists themselves).
- With a part on the configuration needs node capability `access-control-v1`; `encodedPaths` needs `encoded-path-exemptions-v1`. Behaviour: [Access control](../../guide/access-control.en.md).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`accessControl.get`](#accesscontrolget) | `GET /sites/{id}/access-control` | read |
| [`accessControl.update`](#accesscontrolupdate) | `PATCH /sites/{id}/access-control` | write |

### `accessControl.get`

`GET /sites/{id}/access-control` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |

Response: [Access control](#access-control-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `accessControl.update`

`PATCH /sites/{id}/access-control` · write

Replaces the parts present in the request, the others stay as they are; a part present is replaced as a whole, its omitted fields take their defaults.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `siteLists`, `hotlink`, `userAgents`, `cors`, `geo`, `websocket`, `securityHeaders`, `encodedPaths` | body | object | no | Fields in [Access control](#access-control-object); unchanged when omitted | The parts |
| `expectedUpdatedAt` | body | datetime | no | — | The `updatedAt` the caller read |

Response: [Access control](#access-control-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |
| `UPDATED_AT_MISMATCH` | 409 | `expectedUpdatedAt` differs; `data.updatedAt` |
| `CORS_CREDENTIALS_WILDCARD` | 400 | `cors.allowCredentials` is `true` and `allowedOrigins` has `*` |
| `IP_LIST_NOT_FOUND` | 404 | An IP list of `siteLists` does not exist |
| `SITE_LIST_CONFLICT` | 400 | A list is in both `blockListIds` and `allowListIds`; `data.lists` |

## Image format conversion

- Nodes answer with AVIF, WebP or the original by the request's `Accept` and convert only JPEG and PNG responses a cache rule caches; when a conversion fails, is over a limit or would not be smaller, they send the original.
- `imageConvert.update` publishes the site's cluster (reason `site_updated`; no new revision when the nodes' configuration does not change, e.g. while off) and audits `site.image_convert_update` (metadata `changed`, `enabled`). Settings that are on need node capability `image-convert-v1`.
- Behaviour: [Image format conversion](../../guide/image-convert.en.md).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`imageConvert.get`](#imageconvertget) | `GET /sites/{id}/image-convert` | read |
| [`imageConvert.update`](#imageconvertupdate) | `PUT /sites/{id}/image-convert` | write |
| [`imageConvert.savings`](#imageconvertsavings) | `GET /sites/{id}/image-convert/savings` | read |

### `imageConvert.get`

`GET /sites/{id}/image-convert` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |

Response: the settings, fields as in the body of `imageConvert.update` (without `id`); the defaults when never saved.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `imageConvert.update`

`PUT /sites/{id}/image-convert` · write

Replaces the settings; every field is required and the conditions below are checked also while off. Takes no `expectedUpdatedAt`.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `enabled` | body | boolean | yes | Default value `false` | Conversion on |
| `webp` | body | boolean | yes | Default value `true`; at least one of `webp`, `avif` is `true` | Offer WebP |
| `avif` | body | boolean | yes | Default value `false` | Offer AVIF |
| `webpQuality` | body | integer | yes | 1–100, default value `80` | WebP quality |
| `avifQuality` | body | integer | yes | 1–100, default value `50` | AVIF quality |
| `jpeg` | body | boolean | yes | Default value `true`; at least one of `jpeg`, `png` is `true` | Convert `image/jpeg` |
| `png` | body | boolean | yes | Default value `true` | Convert `image/png` |
| `minSize` | body | integer | yes | 0–67108864, default value `1024`; at most `maxSize` | Smallest original converted, in bytes |
| `maxSize` | body | integer | yes | 1–67108864, default value `10485760` | Largest original converted, in bytes |
| `maxPixels` | body | integer | yes | 1–50000000, default value `16000000` | Largest image converted, in pixels |

"Default value" is what a site that never saved them returns.

Response: the saved settings (without `id`).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `imageConvert.savings`

`GET /sites/{id}/image-convert/savings` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `range` | query | enum | no | `1h` / `6h` / `24h` / `7d` / `30d`, default `24h` | Range |

Response: `{ bytesSaved, unsupportedNodes }`: for each complete 200 response to a GET served as a variant (cache hits included) over the range, the original's length minus the variant's, summed (number); and the active nodes of the cluster that do not convert (integer, no `image-convert-v1`).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

## Usage protection

- Limits on bytes sent, requests and bandwidth of a site, with an alert at the warning threshold and at 100%, and at 100% optionally maintenance mode or disabling the site. Evaluated every minute from the nodes' statistics; settings apply from the next evaluation (within a minute).
- Audit: `site.usage_guard_update` (metadata `from`, `to`), `site.usage_guard_delete`, `site.usage_guard_restore`; lifting an action publishes a revision (reason `usage_limit_released`), and deleting the settings also audits `site.usage_guard_release`. When the system applies and lifts actions: `usage_limit_reached` / `usage_limit_released`, `site.usage_guard_apply` / `site.usage_guard_release`.
- Behaviour: [Usage protection](../../guide/usage-protection.en.md).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`usageGuard.get`](#usageguardget) | `GET /sites/{id}/usage-guard` | read |
| [`usageGuard.update`](#usageguardupdate) | `PUT /sites/{id}/usage-guard` | write |
| [`usageGuard.delete`](#usageguarddelete) | `DELETE /sites/{id}/usage-guard` | write |
| [`usageGuard.restore`](#usageguardrestore) | `POST /sites/{id}/usage-guard/restore` | write |

### `usageGuard.get`

`GET /sites/{id}/usage-guard` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |

Response: [Usage protection](#usage-protection-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `usageGuard.update`

`PUT /sites/{id}/usage-guard` · write

Creates or replaces the settings and ends a pause a restore started (`pausedUntil` cleared).

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| Fields of [Usage protection settings](#usage-protection-settings) | body | — | — | See that table | Settings |
| `expectedUpdatedAt` | body | datetime | no | — | The `updatedAt` the caller read |

Response: [Usage protection](#usage-protection-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |
| `UPDATED_AT_MISMATCH` | 409 | `expectedUpdatedAt` differs; `data.updatedAt` |

### `usageGuard.delete`

`DELETE /sites/{id}/usage-guard` · write

Removes the settings, lifting the action they hold. Does nothing without settings.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |

Response: [Usage protection](#usage-protection-object) (`settings` `null`).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `usageGuard.restore`

`POST /sites/{id}/usage-guard/restore` · write

Lifts the action held and applies none until the end of the period (alerts continue).

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |

Response: [Usage protection](#usage-protection-object); `pausedUntil` is the end of the period.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |
| `USAGE_GUARD_NOT_HELD` | 409 | No settings, or no action held |

## Automatic mitigation

- When a node's CC level for the site reaches `threshold`, the system turns on the site's Under Attack (with the site's own challenge type) and publishes (reason `auto_mitigation_started`, audit `site.auto_mitigation_apply`); it stays on for `durationMinutes` after the level was last at the threshold and is then turned off (`auto_mitigation_ended`, `site.auto_mitigation_release`). Off until set up.
- A change that cannot be published (e.g. `NODE_CAPABILITY_REQUIRED`) is rolled back, its error code kept in `lastError` and retried the next minute. `protection.update` changing `underAttack` counts as the operator's: turning it on takes over, turning it off ends the mitigation and pauses it.
- Audit: `site.auto_mitigation_update` (metadata `from`, `to`), `site.auto_mitigation_restore`. Behaviour: [Automatic mitigation](../../guide/attack-dashboard.en.md#automatic-mitigation).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`autoMitigation.get`](#automitigationget) | `GET /sites/{id}/auto-mitigation` | read |
| [`autoMitigation.update`](#automitigationupdate) | `PUT /sites/{id}/auto-mitigation` | write |
| [`autoMitigation.restore`](#automitigationrestore) | `POST /sites/{id}/auto-mitigation/restore` | write |

### `autoMitigation.get`

`GET /sites/{id}/auto-mitigation` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |

Response: [Automatic mitigation](#automatic-mitigation-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `autoMitigation.update`

`PUT /sites/{id}/auto-mitigation` · write

Creates or replaces the settings, applied from the next evaluation (within a minute), and clears `paused` and `lastError`. While Under Attack is held: disabling turns it off at once (publishes `auto_mitigation_ended`, audits `site.auto_mitigation_release`); a shorter `durationMinutes` moves the expiry to no later than now plus the new duration.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `enabled` | body | boolean | no | Default `true` | Enabled |
| `threshold` | body | enum | no | `cookie302` / `js` / `pow` / `captcha`, default `pow` | CC level that starts it |
| `durationMinutes` | body | integer | no | 5–1440, default `30` | Minutes it stays on after the level was last at the threshold |
| `expectedUpdatedAt` | body | datetime | no | — | The `updatedAt` the caller read |

Response: [Automatic mitigation](#automatic-mitigation-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |
| `UPDATED_AT_MISMATCH` | 409 | `expectedUpdatedAt` differs; `data.updatedAt` |

### `autoMitigation.restore`

`POST /sites/{id}/auto-mitigation/restore` · write

Ends it now: turns off the Under Attack the mitigation holds (only audits when it is already off) and starts nothing until the level is below the threshold again (`paused` `true`).

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |

Response: [Automatic mitigation](#automatic-mitigation-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |
| `AUTO_MITIGATION_NOT_ACTIVE` | 409 | The mitigation holds no Under Attack |

## Development mode

| Procedure | Endpoint | Description |
| --- | --- | --- |
| `developmentMode.get` | `GET /sites/{id}/development-mode` | `{ siteId, until, unsupportedNodes }`: `until` is when it ends (`null` while off or once passed), `unsupportedNodes` counts the cluster's active nodes without `development-mode-v1` |
| `developmentMode.set` | `PUT /sites/{id}/development-mode` | `{ "enabled": true }` turns it on for three hours, `false` off now; unchanged, nothing is published or audited (turning it on while on does not extend it). A change publishes the site's cluster (to every node at once, no canary) and audits `site.development_mode_on` / `site.development_mode_off` (`until`). A disabled site cannot turn it on (409 `SITE_DISABLED`) |

The worker checks for expired ones every minute, turns them off, publishes and audits `site.development_mode_expire` as the system; nodes resumed caching at the deadline already. Sites gain `developmentModeUntil`. Read-only AccessKeys can call `GET` only; service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`). Behavior: [Development mode](../../guide/origins-and-cache.en.md#development-mode).

```bash
curl -fsS -X PUT -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"enabled":true}' https://cdn-admin.example.com/api/v1/sites/<site ID>/development-mode
```

## Markdown for Agents

| Procedure | Endpoint | Notes |
| --- | --- | --- |
| `markdown.get` | `GET /sites/{id}/markdown` | The site's Markdown conversion settings; the defaults (off, every path) until saved |
| `markdown.update` | `PUT /sites/{id}/markdown` | Replaces the settings and publishes the site's cluster (hot update; changes while it is off leave the nodes' configuration as it is and create no revision). Prefixes are stored sorted and unique. Audit `site.markdown_update` (`changed`, `enabled`) |
| `markdown.stats` | `GET /sites/{id}/markdown/stats?range=` | `{ responses, unsupportedNodes }`: over the range (`1h`, `6h`, `24h` by default, `7d`, `30d`), the complete 200 GET responses served as Markdown (cache hits included); `unsupportedNodes` counts the cluster's active nodes without `markdown-v1` |

Fields of the settings (all required by `update`, plus `id`):

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | |
| `includePrefixes` | string array | `[]` | Path prefixes converted, empty for every path; ≤ 32, each ≤ 256 bytes, starting with `/`, visible ASCII only |
| `excludePrefixes` | string array | `[]` | Path prefixes never converted, winning over `includePrefixes`; same limits |

Anything else (also while it is off) is 400. A read-only AccessKey calls the `GET`s only; service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`). `sites.features` adds `markdown` (feature `markdown-v1`); settings that are on require node feature `markdown-v1`, settings that are off leave the configuration as it is. Copying settings takes the part `markdown`, and clones copy it. Behaviour: [Markdown for Agents](../../guide/markdown-agents.en.md).

```bash
curl -fsS -X PUT -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"enabled":true,"includePrefixes":["/docs/"],"excludePrefixes":["/docs/private/"]}' \
  https://cdn-admin.example.com/api/v1/sites/<site id>/markdown
curl -fsS -H "x-api-key: $EDGEWEIR_API_KEY" \
  "https://cdn-admin.example.com/api/v1/sites/<site id>/markdown/stats?range=7d"
```

## Tiered Cache

| Procedure | Endpoint | Notes |
| --- | --- | --- |
| `tieredCache.get` | `GET /tiered-cache` | The console-wide setting `{ topology, port, upperNodeIds, upperNodeGroupIds }`; `off` and `8444` by default |
| `tieredCache.update` | `PUT /tiered-cache` | Replaces the console-wide setting and publishes the clusters of the sites that follow it. `topology`: `off`, `smart`, `generic`, `regional`, `custom`; `port` 1–65535, not a listener port; `upperNodeIds` / `upperNodeGroupIds` at most 32 together, used by `custom` only. Audit `system.tiered_cache_update` |
| `tieredCache.site.get` | `GET /sites/{id}/tiered-cache` | The site's setting `{ topology, upperNodeIds, upperNodeGroupIds }`; `topology` also takes `inherit` (the default: the console-wide one) |
| `tieredCache.site.update` | `PUT /sites/{id}/tiered-cache` | Replaces the site's setting and publishes its cluster. Audit `site.tiered_cache_update` (`from`, `to`) |
| `tieredCache.site.selection` | `GET /sites/{id}/tiered-cache/selection` | `{ topology, inherited, target, idleReason, chosenAt, nodes: [{ nodeId, nodeName, regionName, uppers: [{ nodeId, nodeName, reason, rttMs }] }], unsupportedNodes }`: each active node of the cluster with its upper tiers (none: it fetches from the origin) and why (`lowest_latency`, `fallback_region`, `region_upper`, `regional_tier`, `global_upper`, `custom`); `idleReason` is `no_latency`, `no_upper`, `single_node` or `no_custom` when the topology is on but there are no upper tiers |
| `tieredCache.site.stats` | `GET /sites/{id}/tiered-cache/stats?range=` | `{ fetches, served, hitRatio, fallbacks }`: over the range, fetches of lower tiers from upper tiers by the upper tier's cache status (`origin`: fallbacks), requests answered to lower tiers, the upper tiers' hit ratio (0–1, null without fetches) and the fallbacks |

## AI crawl control

- Behavior: [AI crawlers](../../guide/ai-crawl-control.en.md). Site settings need the node capability `ai-crawlers-v1`; the crawler catalogue alone needs none. Audit `system.ai_crawl_update`, `site.ai_crawl_update`.

| Procedure | Method and path | Access |
| --- | --- | --- |
| `aiCrawl.catalogue` | `GET /ai-crawlers` | read |
| `aiCrawl.settings` | `GET /settings/ai-crawl` | read |
| `aiCrawl.setSettings` | `PUT /settings/ai-crawl` | write |
| `aiCrawl.get` | `GET /sites/{id}/ai-crawl` | read |
| `aiCrawl.update` | `PUT /sites/{id}/ai-crawl` | write |
| `aiCrawl.overview` | `GET /sites/{id}/ai-crawl/overview` | read |

`GET /api/v1/openapi.json` has the request and response fields.

## Objects

### Site object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Site ID |
| `name` | string | Name |
| `enabled` | boolean | Enabled; a disabled site is not shipped to nodes |
| `usageGuardHeld` | enum | The action usage protection holds: `maintenance` / `disable`, or `null` |
| `clusterId` | uuid | Cluster ID |
| `clusterName` | string | Cluster name |
| `domains` | `array<string>` | Domains in ASCII (Punycode) form: `a.com`, `*.a.com`, `.a.com`, `~pattern` |
| `cnamePrefix` | string | First label of the CNAME target `<prefix>.<cluster domain>` |
| `tags` | `array<object>` | Tags `{ id, name }` |
| `origins` | array<[Origin](#origin-object)> | Origins in saved order |
| `cacheRules` | array<[Cache rule](#cache-rule-object)> | Cache rules |
| `originSettings` | [Origin pool settings](#origin-pool-settings) | Every field |
| `cacheSettings` | [Cache settings](#cache-settings) | Every field; `purgeMethod` is `{ enabled, keySet }`, the key is never returned |
| `contentSettings` | [Content settings](#content-settings) | Every field |
| `cacheGeneration` | integer | Cache generation in the nodes' configuration; whole-site purges do not change it |
| `ports` | object | Listener ports `{ http: integer[], https: integer[] }`; HTTPS ports serve only with a certificate |
| `delivery` | [Delivery](#delivery-object) | Whether the site's configuration runs on the online nodes |
| `createdAt` | datetime | Created |
| `updatedAt` | datetime | Updated |

### Origin object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Origin ID |
| `address` | string | Host name or IP |
| `port` | integer | Port |
| `scheme` | enum | `http` / `https` |
| `weight` | integer | Weight |
| `backup` | boolean | Backup origin |
| `hostHeader` | string | Host sent to the origin; empty keeps the request's |
| `sni` | string | TLS server name of an HTTPS origin; empty derives it from the Host or address |
| `s3` | object | `{ region, bucket, accessKeyId }`, secrets never returned; `null` for other origins |
| `group` | string | Origin group; empty is the default group |
| `proxyProtocolVersion` | integer | PROXY protocol version sent, 0 for none |

### Cache rule object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Rule ID |
| `priority` | integer | Priority, applied in ascending order |
| `expression` | string | Request condition; `true` matches every request |
| `pathPrefixes`, `paths`, `extensions` | `array<string>` | The condition's structured form when it has one, else empty |
| `statusCodes` | `array<integer>` | Response statuses; empty for any status the rule may cache |
| `minSizeBytes`, `maxSizeBytes` | integer | Response size bounds, 0 unbounded |
| `action` | enum | `cache` / `bypass` |
| `edgeTtlSeconds` | integer | Edge TTL |
| `originCacheControl` | enum | `override` / `respect` |
| `staleWhileRevalidateSeconds`, `staleIfErrorSeconds` | integer | How long stale content is used |
| `cacheAuthorized` | boolean | Cache responses to requests with `Authorization` |
| `browserTtlSeconds` | integer | `max-age` towards clients, 0 keeps the origin's |
| `cacheSetCookie` | boolean | Cache responses with `Set-Cookie` |

### Delivery object

| Field | Type | Description |
| --- | --- | --- |
| `state` | enum | `disabled`; `pending`: no online node runs the site yet; `partial`: some online nodes run an older version or have an unhealthy data plane; `live`: every online node runs its latest version |
| `totalNodes` | integer | Online active nodes of the cluster |
| `servingNodes` | integer | Of those, nodes whose applied configuration has the site (any version); for a disabled site, the nodes that still run it |
| `currentNodes` | integer | Of those, nodes running the site's latest version with a healthy data plane |
| `canary` | object | `{ endsAt, autoPromote }` while the cluster's configuration canary holds the latest version back from the nodes outside the canary (when the window ends; whether every node then gets it without the operator), else `null` |

### Revision object

| Field | Type | Description |
| --- | --- | --- |
| `clusterId` | uuid | Cluster ID |
| `revision` | integer | Revision number |
| `contentHash` | string | Hash of the configuration |
| `siteCount` | integer | Sites in the configuration |
| `reason` | string | English reason |
| `reasonCode` | string | Reason code; empty for revisions from before reason codes |
| `reasonParams` | object | Reason parameters, values string or number |
| `createdAt` | datetime | Created |

### Site mutation result

| Field | Type | Description |
| --- | --- | --- |
| `site` | [Site](#site-object) | The site after the write |
| `revision` | [Revision](#revision-object) | The cluster's revision |
| `certificateReissue` | object | `sites.update` only: `{ id, name }` when the site's ACME certificate is reissued for new domains |

### Site input

The body of `sites.create`.

| Field | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- |
| `name` | string | no | 1–100 after trimming; the first 100 characters of `domains[0]` when omitted | Name |
| `clusterId` | uuid | no | The oldest cluster when omitted | Cluster |
| `domains` | `array<string>` | yes | 1–50, each at most 1024; at most 10 `~pattern`; repeats dropped | `a.com`, `*.a.com` (one label), `.a.com` (any depth, not `a.com`) or `~pattern` (the whole lowercase host); Unicode hosts are stored as Punycode (UTS #46). Forms: [Domain forms](../../guide/domains.en.md#domain-forms) |
| `origins` | array<[Origin input](#origin-input)> | yes | 1–32, at least one in the default group (`group` empty) | Origins, saved in order |
| `cacheRules` | array<[Cache rule input](#cache-rule-input)> | no | At most 64, default `[]` | Cache rules |
| `originSettings` | [Origin pool settings](#origin-pool-settings) | no | Omitted fields take their defaults | Origin pool settings |
| `cacheSettings` | [Cache settings](#cache-settings) | no | Omitted fields take their defaults | Cache settings |
| `ports` | object | no | Default `{ "http": [80], "https": [443] }` | Listener ports |
| `ports.http` | `array<integer>` | yes | At most 17, 1–65535; deduplicated and sorted | 80 or extra HTTP ports of the cluster |
| `ports.https` | `array<integer>` | yes | At most 17, 1–65535; deduplicated and sorted | 443 or extra HTTPS ports of the cluster; ports other than 443 need a certificate |
| `contentSettings` | [Content settings](#content-settings) | no | Omitted fields take their defaults | Content settings |
| `tags` | `array<string>` | no | At most 10, default `[]`; tag name rules in [Site tags and batch operations](#site-tags-and-batch-operations) | Tag names |

### Origin input

| Field | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- |
| `address` | string | yes | 1–253 after trimming; a host name or IPv4 / IPv6 literal (no port, no brackets); the last label not numeric | Origin address; special-purpose IPs and localhost need the platform allow list |
| `port` | integer | no | 1–65535; 80 for `http`, 443 for `https` when omitted | Port |
| `scheme` | enum | no | `http` / `https`, default `http` | Scheme |
| `weight` | integer | no | 1–100, default `1` | Weight |
| `backup` | boolean | no | Default `false` | Backup origin |
| `hostHeader` | string | no | At most 259 after trimming, default `""` | Host sent to the origin: empty keeps the request's; a host name or IP with an optional port (IPv6 in brackets with a port) |
| `sni` | string | no | A host name of at most 253 after trimming and lowercasing, default `""` | TLS server name of an HTTPS origin; empty derives it from the Host or address |
| `s3` | object | no | Default `null` | S3-compatible object storage: requests are signed with AWS Signature V4 |
| `s3.region` | string | yes | Lowercased, matches `[a-z0-9][a-z0-9-]{0,63}` | Region |
| `s3.bucket` | string | no | Default `""`; 3–63 of `[a-z0-9.-]`, a letter or digit first and last | Path-style bucket; empty when the origin address names the bucket |
| `s3.accessKeyId` | string | yes | 1–128 after trimming | Access key ID |
| `s3.secretAccessKey` | string | no | 1–256 | Write-only; omitted keeps the stored secret of the same `accessKeyId`, required for a new `accessKeyId` |
| `group` | string | no | 0–32 of `[a-z0-9_-]`, default `""` | Origin group; empty is the default group, only origin rules send traffic to the others |
| `proxyProtocolVersion` | integer | no | 0–2, default `0`; must be 0 for an S3 origin | PROXY protocol version sent at the start of every connection (node capability `origin-proxy-protocol-v1`) |

### Cache rule input

| Field | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- |
| `priority` | integer | no | 0–10000, unique in the site; (index + 1) × 10 when omitted | Applied in ascending order |
| `expression` | string | no | At most 16384, default `""` | Request condition (phase `cache`, on the client's original request); empty: the three lists are the condition |
| `pathPrefixes` | `array<string>` | no | At most 32, default `[]`; start with `/`, at most 1024, no whitespace | Path prefixes |
| `paths` | `array<string>` | no | At most 32, default `[]`; same rules | Exact paths |
| `extensions` | `array<string>` | no | At most 64, default `[]`; lowercased, leading dot dropped, `[a-z0-9]{1,16}` | Extensions |
| `statusCodes` | `array<integer>` | no | At most 16, 100–599, default `[]` | Response statuses; empty for any status the rule may cache |
| `minSizeBytes` | integer | no | 0–9007199254740991, default `0` | Smallest response in bytes, 0 unbounded |
| `maxSizeBytes` | integer | no | 0–9007199254740991, default `0`; when not 0, at least `minSizeBytes` | Largest response in bytes, 0 unbounded |
| `action` | enum | no | `cache` / `bypass`, default `cache` | Cache or bypass |
| `edgeTtlSeconds` | integer | no | 0–31536000, default `3600` | Edge TTL |
| `originCacheControl` | enum | no | `override` / `respect`, default `respect` | `override` also caches `private` and `no-store` responses |
| `staleWhileRevalidateSeconds` | integer | no | 0–2592000, default `0` | Stale content while revalidating |
| `staleIfErrorSeconds` | integer | no | 0–2592000, default `0` | Stale content while the origin fails |
| `cacheAuthorized` | boolean | no | Default `false` | Cache responses to requests with `Authorization`; off, such requests bypass the cache |
| `browserTtlSeconds` | integer | no | 0–31536000, default `0` | `Cache-Control: max-age` towards clients, 0 keeps the origin's |
| `cacheSetCookie` | boolean | no | Default `false` | Cache responses with `Set-Cookie` (`site-content-v1`); only the response fetched from the origin carries the cookies |

With an `expression`, the three lists are empty or equal to the expression's structured form (as `sites.get` returns it); an invalid expression is a validation error.

### Origin pool settings

Omitted fields of a request take their defaults (`sites.update` has exceptions, see there); responses carry every field.

| Field | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- |
| `policy` | enum | no | `weighted_random` / `round_robin` / `consistent_hash`, default `weighted_random` | Load balancing |
| `tlsVerify` | boolean | no | Default `true` | Verify certificates of HTTPS origins |
| `tlsTrust` | enum | no | `system` / `originCa`, default `system` | Trust anchors: the node's trust store, or only the Origin CA (`origin-ca-v1`; needs `tlsVerify`, no S3 origin) |
| `clientCertificate` | boolean | no | Default `false` | Present the cluster's origin client certificate to HTTPS origins that request one (`origin-mtls-v1`; not to S3 origins) |
| `maxFails` | integer | no | 1–100, default `3` | Passive health check: consecutive failures that mark an origin down |
| `recoverySeconds` | integer | no | 1–3600, default `30` | Passive health check: seconds before a down origin is tried again |
| `connectTimeoutMs` | integer | no | 100–120000, default `10000` | Connect timeout |
| `sendTimeoutMs` | integer | no | 100–3600000, default `60000` | Send timeout |
| `readTimeoutMs` | integer | no | 100–3600000, default `60000` | Read timeout |
| `keepalive` | boolean | no | Default `true` | Reuse upstream connections |
| `keepaliveIdleSeconds` | integer | no | 1–3600, default `60` | Idle connection lifetime |
| `keepaliveMaxRequests` | integer | no | 1–100000, default `1000` | Requests per connection at most |
| `websocket` | boolean | no | Default `true` | Proxy WebSocket upgrades |
| `protocol` | enum | no | `http1` / `http2`, default `http1` | HTTP version towards the origins; `http2` (`origin-http2-v1`) uses ALPN h2 to HTTPS origins and h2c to HTTP ones, never falling back to HTTP/1.1; WebSocket always uses HTTP/1.1 |
| `grpc` | boolean | no | Default `false`; needs `protocol` `http2` | Proxy gRPC requests over HTTP/2 end to end (never cached, not inspected by the OWASP CRS) |
| `activeHealthCheck` | object | no | Omitted fields take their defaults | Active health check (`active-health-v1`), kept while off |
| `activeHealthCheck.enabled` | boolean | no | Default `false` | On |
| `activeHealthCheck.type` | enum | no | `http` / `grpc`, default `http` | `grpc` (`active-health-grpc-v1`): `grpc.health.v1.Health/Check`, healthy when the answer is `SERVING`; `path`, `method` and the status range are not used |
| `activeHealthCheck.grpcService` | string | no | 0–255 printable ASCII without spaces, default `""` | Service asked about by the gRPC check; empty for the server's overall health |
| `activeHealthCheck.path` | string | no | `/` and then up to 1023 printable ASCII without spaces (a query allowed), default `/` | Request path |
| `activeHealthCheck.method` | enum | no | `GET` / `HEAD`, default `GET` | Request method |
| `activeHealthCheck.expectedStatusMin` | integer | no | 100–599, default `200`; at most `expectedStatusMax` | Lowest healthy status (inclusive) |
| `activeHealthCheck.expectedStatusMax` | integer | no | 100–599, default `399` | Highest healthy status (inclusive) |
| `activeHealthCheck.host` | string | no | A host name, default `""` | Host of the probes; empty uses the origin's `hostHeader`, else its address |
| `activeHealthCheck.intervalSeconds` | integer | no | 5–300, default `30` | Probe interval |
| `activeHealthCheck.timeoutSeconds` | integer | no | 1–60, default `5`; at most `intervalSeconds` | Probe timeout |
| `activeHealthCheck.healthyThreshold` | integer | no | 1–10, default `2` | Successes in a row that bring an origin back |
| `activeHealthCheck.unhealthyThreshold` | integer | no | 1–10, default `3` | Failures in a row that mark an origin down |
| `sessionAffinity` | object | no | Omitted fields take their defaults | Cookie-based session affinity (`session-affinity-v1`), kept while off |
| `sessionAffinity.enabled` | boolean | no | Default `false` | On |
| `sessionAffinity.ttlSeconds` | integer | no | 60–604800, default `3600` | Seconds a client stays pinned to its origin |
| `tries` | integer | no | 1–5, default `3` | Origins a request tries at most (`site-content-v1` unless 3) |
| `statusRetry` | boolean | no | Default `true` | Retry after 502, 503 and 504 answers (`site-content-v1` when off) |

### Cache settings

Omitted fields of a request take their defaults (`sites.update` has exceptions, see there). In responses `purgeMethod` is `{ enabled, keySet }`.

| Field | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- |
| `cacheKey` | object | no | Omitted fields take their defaults | Cache key |
| `cacheKey.query` | enum | no | `all` / `ignore` / `include` / `exclude`, default `all` | Query parameters: all, none, only `queryParams`, all but `queryParams` (`exclude` needs `site-content-v1`) |
| `cacheKey.queryParams` | `array<string>` | no | At most 32, default `[]`; each 1–128 after trimming, without whitespace, `&`, `=`, `#` | Parameters kept by `include` or dropped by `exclude`; under `exclude` a name may end in `*` for a prefix (a lone `*` may not) |
| `cacheKey.sortQuery` | boolean | no | Default `false` | Sort parameters |
| `cacheKey.headers` | `array<string>` | no | At most 8, default `[]`; lowercased 1–64 token characters, not `cookie` or `host` | Request headers that vary the key |
| `cacheKey.cookies` | `array<string>` | no | At most 8, default `[]`; 1–64 token characters | Cookies that vary the key |
| `cacheKey.deviceType` | boolean | no | Default `false` | Separate mobile and desktop user agents |
| `cacheKey.includeHost` | boolean | no | Default `true` | Include the Host; off, every domain of the site shares cached objects |
| `rangeSlice` | boolean | no | Default `false` | Fetch and cache large files in 1 MiB slices |
| `keepCacheTag` | boolean | no | Default `false` | Forward the origin's `Cache-Tag` header to clients; nodes index it either way |
| `xCache` | boolean | no | Default `true` | Send `X-Cache` (`site-content-v1` when off) |
| `purgeMethod` | object | no | Default `{ "enabled": false }` | PURGE method (`site-content-v1`): `PURGE <URL>` with `X-Purge-Key` purges the URL |
| `purgeMethod.enabled` | boolean | no | Default `false` | On; needs a stored key or `key` |
| `purgeMethod.key` | string | no | 16–256 printable ASCII without spaces | Write-only; omitted keeps the stored key |

### Content settings

| Field | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- |
| `charset` | object | no | Omitted fields take their defaults | Charset added to `text/*`, `application/javascript`, `application/json` and `application/xml` responses |
| `charset.name` | enum | no | `off` / `utf-8` / `gbk` / `gb18030` / `gb2312` / `big5` / `iso-8859-1` / `shift_jis` / `euc-kr`, default `off` | Charset; `off` adds none |
| `charset.force` | boolean | no | Default `false` | Also replace a charset the response names |
| `charset.uppercase` | boolean | no | Default `false` | Send the name in upper case |
| `requestBodyLimit` | integer | no | 0–10737418240, default `104857600` | Largest request body by `Content-Length` in bytes, 413 above it; 0 no limit |
| `rulesBodyLimit` | integer | no | 1024–1048576, default `65536` | Largest request body the rules read (`rules-body-v1`); larger ones count as truncated |

Content settings other than the defaults need node capability `site-content-v1`.

### Launch check object

| Field | Type | Description |
| --- | --- | --- |
| `addresses` | `array<string>` | The cluster's edge addresses (values of A / AAAA records): the scheduling addresses configured for its online active nodes, else the public addresses they report |
| `domains` | `array<object>` | One entry per domain |
| `domains[].name` | string | As on the site |
| `domains[].probe` | string | The name looked up: the domain, or `edgeweir-check.<suffix>` under a wildcard; empty when `unchecked` |
| `domains[].pointing` | enum | `ok`: every address it resolves to is an active node's of the cluster; `elsewhere`: some address is not; `unresolved`: no A or AAAA record; `unknown`: the lookup failed or no node address is known; `unchecked`: a `.a.com` or `~pattern` domain, which names no single host |
| `certificate.state` | enum | `none`: no certificate; `covered`: its chain covers every domain; `uncovered`: it does not cover `uncovered`; `issuing`: an ACME issuance is pending or running; `failed`: the last one failed or nodes cannot load the certificate; `expired` |
| `certificate.id` | uuid | Certificate ID, or `null` |
| `certificate.name` | string | Certificate name |
| `certificate.uncovered` | `array<string>` | Domains the current chain does not cover (all before the first issuance); `.a.com` and pattern domains are not checked |
| `certificate.error` | string | Certificate error code of a failure |
| `delivery` | [Delivery](#delivery-object) | Delivery |

### Origin health object

| Field | Type | Description |
| --- | --- | --- |
| `originId` | uuid | Origin ID |
| `downNodes` | integer | Online nodes where either check marks the origin down |
| `onlineNodes` | integer | Online nodes of the cluster |
| `lastError` | string | The node's text of the most recent failure across nodes |
| `lastErrorCode` | string | Its stable code; empty when unknown |
| `lastErrorParams` | object | The code's parameters, string values |
| `lastFailureAt` | datetime | Most recent failure, or `null` |
| `nodes` | `array<object>` | One entry per node and source; a node's active entry only exists while active checks run |
| `nodes[].nodeId`, `nodes[].nodeName` | uuid, string | Node |
| `nodes[].source` | enum | `passive` (real traffic) / `active` (probes) |
| `nodes[].healthy` | boolean | Healthy |
| `nodes[].consecutiveFailures` | integer | Failures in a row |
| `nodes[].lastError`, `nodes[].lastErrorCode`, `nodes[].lastErrorParams`, `nodes[].lastFailureAt` | — | That node's and source's latest failure, as above |
| `nodes[].downUntil` | datetime | End of a passive down period; always `null` for active entries |
| `nodes[].reportedAt` | datetime | Reported |

### Origin quality object

| Field | Type | Description |
| --- | --- | --- |
| `range` | enum | The range asked for |
| `bucketSeconds` | integer | Seconds per bucket |
| `from`, `to` | datetime | Bounds of the counts |
| `times` | `array<datetime>` | Start of each bucket, oldest first |
| `items` | `array<object>` | The site's current origins in pool order; origins deleted since are left out |
| `items[].originId` | uuid | Origin ID |
| `items[].address`, `items[].port`, `items[].scheme`, `items[].group`, `items[].backup` | — | The origin's address, port, scheme, group and backup flag |
| `items[].requests` | integer | Attempts sent to the origin (retries count again) |
| `items[].failures` | object | Failed attempts by class `{ connect, timeout, tls, invalid, server }`; `server` counts 5xx answers |
| `items[].errors` | integer | All failures and 5xx answers |
| `items[].errorRate` | number | `errors / requests`; 0 without attempts |
| `items[].answered` | integer | Attempts the origin answered (with a header time) |
| `items[].meanMs`, `items[].p50Ms`, `items[].p95Ms`, `items[].p99Ms` | number | Time to the response header: mean and percentiles (interpolated in the buckets, approximate), milliseconds; `null` without answers |
| `items[].series` | object | Per bucket, aligned with `times`: `{ requests: integer[], errors: integer[], p95Ms: (number or null)[] }` |
| `unsupportedNodes` | integer | Active nodes of the cluster without `origin-stats-v1`; the counts are partial when not 0 |

### Site features object

Each field is `{ available, reason }`: `available` is a boolean; when an active node of the cluster lacks the capability, `available` is `false` and `reason` is `nodes`, else `reason` is `null`. With `available` `false` the operator can still turn the feature on through the API; nodes without the capability keep their configuration.

| Field | Node capability | Feature |
| --- | --- | --- |
| `brotli`, `zstd` | `brotli-v1`, `zstd-v1` | Brotli, Zstandard compression |
| `crs` | `modsecurity-v1` | OWASP CRS |
| `activeHealthCheck` | `active-health-v1` | Active health checks |
| `sessionAffinity` | `session-affinity-v1` and `challenge-v1` | Session affinity |
| `originHttp2` | `origin-http2-v1` | HTTP/2 and gRPC towards origins |
| `originProxyProtocol` | `origin-proxy-protocol-v1` | PROXY protocol towards origins |
| `activeHealthGrpc` | `active-health-grpc-v1` | gRPC active health checks |
| `originMtls` | `origin-mtls-v1` | Origin client certificates |
| `originCa` | `origin-ca-v1` (and `origin-ca-rotation-v1` during a CA rotation) | Trusting only the Origin CA |
| `errorPages` | `error-pages-v1` | Error pages |
| `purgeByTag` | `purge-tag-v1` | Purges by host and Cache-Tag |
| `prefetchVariants` | `prefetch-v2` | Prefetching the mobile variant and sitemaps |
| `rulesV2` | `rules-v2` | Rule engine extensions: functions and new fields, dynamic redirects and rewrites, origin, compression and other config actions, cache rule expressions outside the builder's shape, browser TTLs, bulk redirects and origin groups |
| `rulesV3` | `rules-v3` | Rule engine additions: new fields, functions and wildcard comparisons, header values and query parameters computed per request, redirect status 303, error page placeholders `{{time}}` and `{{path}}` |
| `edgePorts` | `edge-ports-v1` | Ports besides 80 and 443 and the HTTPS redirect's status, port and excluded domains |
| `clientIp` | `client-ip-v1` | Rule field `ip.peer` |
| `siteContent` | `site-content-v1` | Cache keys that drop parameters, caching responses with `Set-Cookie`, the PURGE method, hiding `X-Cache`, error pages for more statuses and redirects, maintenance, charsets, the gzip level and largest compressed response, request body limits and origin tries |
| `domainsV2` | `domains-v2` | `.a.com` and `~pattern` domains |
| `multiCertificate` | `multi-certificate-v1` | Several certificates |
| `clientCertificate` | `client-cert-v1` | Client certificates and the `tls.client.*` fields |
| `accessAuth` | `access-auth-v1` | Access authentication |
| `accessControl` | `access-control-v1` | Access control |
| `encodedPaths` | `encoded-path-exemptions-v1` | Encoded path exceptions |
| `wafV2` | `waf-v2` | WAF actions ban, respond, close and skip, access log lines from log rules, rate limit bans, the config rules' CRS override, CRS exclusions by path or target |
| `rulesBody` | `rules-body-v1` | Request body fields and `form_value` / `json_value` in rules |
| `challengeV2` | `challenge-v2` | Verified crawlers, challenge page texts and challenge failure bans |
| `accessLogsV2` | `access-logs-v2` | Access log options: always logging blocked requests, the query string, request headers and the peer address |
| `imageConvert` | `image-convert-v1` | Image format conversion |
| `challengeV3` | `challenge-v3` | The managed challenge and third-party interactive challenges |
| `markdown` | `markdown-v1` | Markdown for Agents |
| `aiCrawl` | `ai-crawlers-v1` | AI crawl control: crawler actions, the managed robots.txt and pay per crawl |

### Batch result

| Field | Type | Description |
| --- | --- | --- |
| `changed` | `array<object>` | Sites that changed `{ id, name }`; sites already as asked are left out |
| `revisions` | `array<object>` | One entry per cluster published, `{ clusterId, revision, created }`; `created` `false`: the configuration did not change and `revision` is the latest |

### Copy preview object

| Field | Type | Description |
| --- | --- | --- |
| `source` | object | Source site `{ id, name }` |
| `targets` | `array<object>` | One entry per target |
| `targets[].id`, `targets[].name` | uuid, string | Target site |
| `targets[].changes` | `array<object>` | One entry per part `{ part, changed, before, after, fields }`: `changed` is a boolean; `before`, `after` are item counts for list parts (`null` otherwise); `fields` is the number of settings that would change for other parts (`null` for list parts) |
| `targets[].error` | object | `{ code, message, data }` (API error code, English message, parameters with string or number values) when the copy would fail, else `null`; nothing of a failing target would change |

### Copy result object

| Field | Type | Description |
| --- | --- | --- |
| `targets` | `array<object>` | One entry per target |
| `targets[].id`, `targets[].name` | uuid, string | Target site |
| `targets[].ok` | boolean | Copied |
| `targets[].changed` | `array<enum>` | Parts whose settings changed |
| `targets[].revision` | [Revision](#revision-object) | The revision of the target's cluster after the copy; `null` when it failed |
| `targets[].error` | object | Why it failed `{ code, message, data }`; `null` on success |

### Cache task object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Task ID |
| `type` | enum | `url` / `prefix` / `site` / `prefetch` / `host` / `tag` / `sitemap` |
| `targets` | `array<string>` | What was asked for: URLs, prefixes, site names, hosts, normalized tags or the sitemap URL |
| `sites` | `array<object>` | Sites involved `{ id, name }`; deleted sites are left out |
| `variants` | `array<enum>` | Device variants (`desktop`, `mobile`) of a prefetch or sitemap task; `[]` for purges |
| `maxUrls` | integer | URL limit of a sitemap task; `null` for other types |
| `state` | enum | `pending`: no node finished; `running`: some finished; then `succeeded` or `failed`. `skipped` nodes do not count |
| `nodes` | `array<object>` | One entry per node |
| `nodes[].nodeId`, `nodes[].nodeName` | uuid, string | Node |
| `nodes[].state` | enum | `pending` / `running` / `succeeded` / `failed` / `skipped` (the node was disabled before it ran the task) |
| `nodes[].message` | string | The node's text of the outcome (English for unknown codes) |
| `nodes[].errorCode` | string | Stable code of the outcome; empty on success |
| `nodes[].errorParams` | object | The code's parameters, string values |
| `nodes[].succeeded`, `nodes[].failed` | integer | Items that succeeded and failed |
| `nodes[].finishedAt` | datetime | Finished, or `null` |
| `nodes[].recoveredAt` | datetime | When a missed purge (`task_expired`, `node_disabled`) was made up with a whole-site purge, or `null` |
| `source` | enum | `user`: created in the console or the API; `recovery`: a whole-site purge the console sent a node that missed purges; `purge_method`: a PURGE request a node accepted (`createdByName` is the node) |
| `createdByName` | string | Creator's name |
| `createdAt` | datetime | Created |
| `finishedAt` | datetime | Finished, or `null` |

### HTTPS settings

`settings` of `https.update` and the response of `https.get`. Omitted fields of a request take their defaults.

| Field | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- |
| `certificateId` | uuid | no | Default `null` | The site's first certificate; `null` for HTTP only |
| `additionalCertificateIds` | `array<uuid>` | no | 0–3, default `[]`; need `certificateId`, distinct, not `certificateId` | Further certificates (`multi-certificate-v1`); every domain of the site is covered by one of them, handshakes pick by SNI |
| `forceHttps` | boolean | no | Default `false`; needs a certificate | Redirect HTTP to HTTPS |
| `hstsMaxAge` | integer | no | 0–63072000, default `0`; not 0 needs a certificate | HSTS `max-age`, 0 sends none |
| `hstsIncludeSubdomains` | boolean | no | Default `false` | HSTS `includeSubDomains` |
| `hstsPreload` | boolean | no | Default `false` | HSTS `preload` |
| `minimumVersion` | enum | no | `1.2` / `1.3`, default `1.2` | Minimum TLS version |
| `cipherProfile` | enum | no | `modern` / `compatible`, default `modern` | Cipher suites |
| `http2` | boolean | no | Default `true` | HTTP/2 |
| `http3` | boolean | no | Default `false` | HTTP/3 |
| `brotli` | boolean | no | Default `false` | Brotli compression (`brotli-v1`) |
| `brotliLevel` | integer | no | 1–11, default `6` | Brotli level |
| `brotliMinLength` | integer | no | 1–1048576, default `256` | Smallest response compressed, in bytes |
| `brotliTypes` | `array<string>` | no | At most 32 MIME types (`type/subtype`, lowercase, no parameters); default `text/html`, `text/plain`, `text/css`, `application/javascript`, `application/json`, `image/svg+xml` | Types compressed |
| `zstd` | boolean | no | Default `false` | Zstandard compression (`zstd-v1`) |
| `zstdLevel` | integer | no | 1–19, default `3` | Zstandard level |
| `zstdMinLength`, `zstdTypes` | integer, `array<string>` | no | As `brotliMinLength`, `brotliTypes` | Zstandard's smallest size and types |
| `gzip` | boolean | no | Default `true` | gzip compression |
| `gzipMinLength`, `gzipTypes` | integer, `array<string>` | no | As `brotliMinLength`, `brotliTypes` | gzip's smallest size and types |
| `gzipLevel` | integer | no | 0–9, default `0` | gzip level; 0 keeps the nodes' default (1), other values need `site-content-v1` |
| `compressMaxLength` | integer | no | 0–9007199254740991, default `0` | Largest response, by its known length, any coding compresses; 0 no limit (`site-content-v1` otherwise); responses of unknown length are compressed |
| `ocspStapling` | boolean | no | Default `false` | OCSP stapling |
| `redirectStatus` | integer | no | 301 / 302 / 303 / 307 / 308, default `301` | Status of the redirect of `forceHttps` and of config rules' `forceHttps` |
| `redirectPort` | integer | no | 1–65535, default `443`; 443 or an HTTPS port of the site | Port of the redirect's target URL |
| `redirectExcludedDomains` | `array<string>` | no | At most 50 domains, default `[]`; deduplicated and sorted; exact or `*.` domains of the site | Domains `forceHttps` leaves alone (a config rule still redirects them) |
| `clientCertificate` | object | no | Omitted fields take their defaults | Client certificates (`client-cert-v1`) |
| `clientCertificate.mode` | enum | no | `off` / `optional` / `required`, default `off`; not `off` needs a certificate and `caPem` | `optional` verifies a certificate the visitor presents; `required` answers requests without a valid one (plain HTTP included) with the 403 error page |
| `clientCertificate.caPem` | string | no | At most 65536 bytes, default `""` | Client CA (PEM), re-encoded by the server |
| `clientCertificate.depth` | integer | no | 1–5, default `2` | Verification depth |
| `clientCertificate.forwardHeaders` | boolean | no | Default `false` | Send `X-Client-Verify`, `X-Client-Cert-SHA256`, `X-Client-Cert-Subject` and `X-Client-Cert-Serial` to the origin; visitors' own headers of these names are always removed |

Clients that accept several encodings at equal q-values get zstd, then br, then gzip.

### Error pages object

| Field | Type | Description |
| --- | --- | --- |
| `siteId` | uuid | Site ID |
| `pages` | `array<object>` | At most one page per status; `4xx` and `5xx` first, then by status |
| `pages[].status` | integer or enum | Status, or `"4xx"` / `"5xx"` |
| `pages[].template` | string | HTML template; empty for a redirect page |
| `pages[].redirectUrl` | string | Target of the 302; empty for a template page |
| `pages[].responseStatus` | integer | Status a template page is sent with; 0 keeps the response's |
| `interceptOriginErrors` | boolean | Also replace origin responses whose status has a page |
| `updatedAt` | datetime | Updated; `null` until first saved |

### Maintenance object

| Field | Type | Description |
| --- | --- | --- |
| `siteId` | uuid | Site ID |
| `enabled` | boolean | On |
| `template` | string | Page template; empty for the nodes' built-in page |
| `retryAfterSeconds` | integer | `Retry-After` in seconds, 0 sends none |
| `allowedCidrs` | `array<string>` | Addresses or CIDRs let through |
| `allowedPathPrefixes` | `array<string>` | Path prefixes let through |
| `updatedAt` | datetime | Updated; `null` until first saved |

### Access authentication object

| Field | Type | Description |
| --- | --- | --- |
| `siteId` | uuid | Site ID |
| `rules` | `array<object>` | Rules in matching order |
| `rules[].id` | uuid | Rule ID |
| `rules[].kind` | enum | `basic` / `forward` / `url_a` / `url_b` / `url_c` / `url_d` |
| `rules[].enabled` | boolean | Enabled |
| `rules[].scope` | object | `{ domains, pathPrefixes, extensions, excludePathPrefixes }`, each `array<string>` |
| `rules[].basic` | object | `{ realm, keepAuthorization, userHeader, users: [{ name }] }`, user names only; `null` for other kinds |
| `rules[].forward` | object | `{ url, method, timeoutMs, requestHeaders, responseHeaders, cacheSeconds, passRedirects, allowUnavailable }`; `null` for other kinds |
| `rules[].url` | object | `{ validitySeconds, skewSeconds, signParam, timeParam, backupKey }`, `backupKey` telling whether a backup key is set (boolean); `null` for other kinds |
| `updatedAt` | datetime | Updated; `null` until first saved |
| `formerIdentityHeaders` | `array<string>` | Identity headers of former rules (disabled ones count as current) that nodes still remove from every request of the site, oldest first |

### Access authentication rule input

| Field | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- |
| `id` | uuid | no | — | An existing rule: its stored passwords and keys are kept; omitted for a new rule |
| `kind` | enum | yes | `basic` / `forward` / `url_a` / `url_b` / `url_c` / `url_d` | Kind; carries only the matching `basic`, `forward` or `url` |
| `enabled` | boolean | no | Default `true` | Enabled |
| `scope` | object | no | Every list empty by default | Requests the rule checks; empty lists do not narrow it |
| `scope.domains` | `array<string>` | no | At most 50, default `[]` | Domains of the site, as written on the site |
| `scope.pathPrefixes` | `array<string>` | no | At most 32, default `[]`; start with `/`, no whitespace, `?`, `#` or control characters, at most 1024 bytes (UTF-8) | Path prefixes |
| `scope.extensions` | `array<string>` | no | At most 64, default `[]`; lowercase without the dot, `[a-z0-9]{1,16}` | Extensions |
| `scope.excludePathPrefixes` | `array<string>` | no | At most 32, default `[]`; as `pathPrefixes` | Excluded path prefixes |
| `basic.realm` | string | yes | 1–64 characters after trimming, without `"`, `\` and control characters | Realm of `WWW-Authenticate` |
| `basic.keepAuthorization` | boolean | no | Default `false` | Keep `Authorization` towards the origin; off, it is removed |
| `basic.userHeader` | boolean | no | Default `false` | Add `X-Auth-User` towards the origin (replacing a visitor's own) |
| `basic.users` | `array<object>` | yes | 1–100, distinct names | Users |
| `basic.users[].name` | string | yes | 1–64 printable ASCII without spaces and `:` | User name |
| `basic.users[].password` | string | no | 8–128 characters, no control characters | Write-only; omitted keeps the user's stored password, required for a new user |
| `forward.url` | string | yes | At most 2048 after trimming; an `http(s)` URL whose host is a host name, IPv4 or bracketed IPv6, without credentials, fragment, spaces or `\` | Authentication service |
| `forward.method` | enum | no | `GET` / `HEAD`, default `GET` | Request method |
| `forward.timeoutMs` | integer | no | 100–10000, default `5000` | Timeout |
| `forward.requestHeaders` | `array<string>` | no | At most 16, default `["authorization", "cookie"]`; not `host`, hop-by-hop headers, `content-length`, `x-original-*`, `x-real-ip`, `x-forwarded-for` or `x-edgeweir-*` | Visitor's request headers sent to the service |
| `forward.responseHeaders` | `array<string>` | no | At most 8, default `[]`; 1–64 token characters, not a protected header or `x-edgeweir-*` | Headers of a 2xx answer copied to the request towards the origin |
| `forward.cacheSeconds` | integer | no | 0–300, default `0` | Seconds a result is cached, 0 off |
| `forward.passRedirects` | boolean | no | Default `false` | Pass a 3xx answer's status and `Location` on to the visitor |
| `forward.allowUnavailable` | boolean | no | Default `false` | When the service is unavailable (5xx, connection failure, timeout), the request continues without authentication |
| `url.validitySeconds` | integer | no | 1–31536000, default `1800` | Signature validity |
| `url.skewSeconds` | integer | no | 0–600, default `300` | Clock skew allowed |
| `url.signParam` | string | no | `[A-Za-z0-9_-]{1,32}`, default `sign` | Signature parameter |
| `url.timeParam` | string | no | `[A-Za-z0-9_-]{1,32}`, default `t`; for `url_d` not equal to `signParam` | Time parameter |
| `url.primaryKey` | string | no | 16–128 printable ASCII without spaces | Write-only; omitted keeps the stored primary key, required for a new rule |
| `url.backupKey` | string | no | As `primaryKey`; or `null` | Write-only; omitted keeps it, `null` removes the backup key |

### Access control object

The responses of `accessControl.get` and `accessControl.update` also carry `siteId` (uuid) and `updatedAt` (datetime; `null` until first saved). Omitted fields of a part in a request take the defaults below.

| Field | Type | Constraints and default | Description |
| --- | --- | --- | --- |
| `siteLists.blockListIds` | `array<uuid>` | At most 16, default `[]`; deduplicated | IP lists whose addresses get 403 on this site |
| `siteLists.allowListIds` | `array<uuid>` | At most 16, default `[]`; deduplicated | IP lists whose addresses skip this site's block lists, bans, geo, hotlink, user agent checks and challenges |
| `hotlink.enabled` | boolean | Default `false` | Hotlink protection on |
| `hotlink.allowEmpty` | boolean | Default `true` | Let requests without `Referer` through |
| `hotlink.allowSiteDomains` | boolean | Default `true` | Let requests from the site's own domains through |
| `hotlink.allowed`, `hotlink.denied` | `array<string>` | At most 200 each, default `[]`; `a.com`, `*.a.com`, `.a.com` or `*`, at most 256, lowercased, deduplicated | Sources allowed and denied |
| `hotlink.checkOrigin` | boolean | Default `false` | Check `Origin` as well when the request has one |
| `hotlink.extensions` | `array<string>` | At most 64; default 49 common image, audio, video and download types | Extensions checked |
| `hotlink.pathPrefixes`, `hotlink.excludePathPrefixes` | `array<string>` | At most 32 each, default `[]`; start with `/`, no whitespace, `?`, `#` or control characters, at most 1024 bytes | Path prefixes checked and excluded |
| `hotlink.action` | enum | `deny` / `redirect`, default `deny` | `deny`: 403 with the error page; `redirect`: 302 to `redirectUrl` |
| `hotlink.redirectUrl` | string | At most 2048 after trimming, default `""`; required for `redirect` | A site path or an `http(s)` URL |
| `userAgents.rules` | `array<object>` | At most 200, default `[]` | `{ pattern, action }`: `pattern` is empty or a wildcard of 1–512 printable ASCII (at most 8 `*`, escaping only `*` and `\`); `action` is `allow` / `deny` |
| `userAgents.pathPrefixes`, `userAgents.excludePathPrefixes` | `array<string>` | As `hotlink.pathPrefixes` | Path prefixes checked and excluded |
| `cors.enabled` | boolean | Default `false`; when on, at least one `allowedOrigins` | CORS on |
| `cors.allowedOrigins` | `array<string>` | At most 100, default `[]`; `scheme://host[:port]`, `https://*.a.com` or `*`, at most 300 | Origins allowed |
| `cors.allowCredentials` | boolean | Default `false`; not together with `*` | `Access-Control-Allow-Credentials` |
| `cors.allowedMethods` | `array<string>` | 1–16, uppercased; default `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` | Methods allowed |
| `cors.allowedHeaders`, `cors.exposedHeaders` | `array<string>` | At most 64 each, default `[]`; lowercased 1–64 token characters | Headers allowed and exposed |
| `cors.echoRequestHeaders` | boolean | Default `false` | Answer preflights with their `Access-Control-Request-Headers` |
| `cors.maxAgeSeconds` | integer | 0–86400, default `600` | Preflight cache seconds |
| `cors.preflightToOrigin` | boolean | Default `false` | Preflights go to the origin instead of being answered at the edge |
| `cors.keepOriginHeaders` | boolean | Default `false` | When the origin's response has `Access-Control-Allow-Origin`, no `Access-Control-*` header is changed |
| `cors.pathPrefixes` | `array<string>` | As `hotlink.pathPrefixes` | Path prefixes it applies to |
| `geo.enabled` | boolean | Default `false`; when on, at least one of `countries`, `subdivisions`, `asns` | Geo access control on |
| `geo.mode` | enum | `allow` / `deny`, default `deny` | `allow`: only matching clients pass; `deny`: matching clients get 403 |
| `geo.countries` | `array<string>` | At most 256, default `[]`; two letters, uppercased | Country codes |
| `geo.subdivisions` | `array<string>` | At most 256, default `[]`; `CC-subdivision`, e.g. `US-CA` | Subdivisions |
| `geo.asns` | `array<integer>` | At most 256, 1–4294967295, default `[]` | ASNs |
| `geo.pathPrefixes`, `geo.exceptPathPrefixes` | `array<string>` | As `hotlink.pathPrefixes` | Path prefixes it applies to and excepts |
| `websocket.allowAllOrigins` | boolean | Default `true`; when `false`, at least one `origins` | WebSocket from any origin |
| `websocket.origins` | `array<string>` | At most 100, default `[]`; `https://a.com[:port]` or `https://*.a.com`, at most 300 | Origins allowed |
| `websocket.idleTimeoutSeconds` | integer | 60–86400, default `3600` | Idle timeout |
| `securityHeaders.nosniff` | boolean | Default `false` | `X-Content-Type-Options: nosniff` |
| `securityHeaders.frameOptions` | enum | `off` / `DENY` / `SAMEORIGIN`, default `off` | `X-Frame-Options` |
| `securityHeaders.referrerPolicy` | enum | `off`, `no-referrer`, `no-referrer-when-downgrade`, `origin`, `origin-when-cross-origin`, `same-origin`, `strict-origin`, `strict-origin-when-cross-origin`, `unsafe-url`, default `off` | `Referrer-Policy` |
| `securityHeaders.permissionsPolicy` | string | At most 1024 printable ASCII after trimming, default `""` | `Permissions-Policy`; empty sets none |
| `securityHeaders.hideServer` | boolean | Default `false` | Hide `Server` |
| `securityHeaders.removePoweredBy` | boolean | Default `false` | Remove `X-Powered-By` |
| `encodedPaths.exemptions` | `array<object>` | At most 32, default `[]`; distinct `prefix` | `{ prefix, encodedSlash, semicolon }`: requests whose raw path starts with `prefix` may carry `%2F` (`encodedSlash`) and / or `;` (`semicolon`) as they are, at least one `true` (both default `false`); `prefix` is 1–256 printable ASCII starting with `/`, without `%`, `;`, `\`, `#`, `?`, `//` or dot segments |

### Usage protection settings

The request fields of `usageGuard.update` and `settings` of `usageGuard.get`. At least one of `bytesLimit`, `requestsLimit` and `bandwidthBps` is not `null`.

| Field | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- |
| `period` | enum | no | `day` / `month`, default `month` | Calendar day / month |
| `timeZone` | string | yes | IANA time zone name of 1–64 after trimming | The period starts at midnight there |
| `bytesLimit` | string | no | A positive decimal integer of 1–38 digits (no leading zero), or `null`; default `null` | Bytes sent to visitors per period |
| `requestsLimit` | string | no | As `bytesLimit` | Requests per period |
| `bandwidthBps` | integer | no | 1000–10000000000000, or `null`; default `null` | Bandwidth limit (bit/s, the average of the last 5 complete minutes across every node) |
| `warnPercent` | integer | no | 1–99, or `null`; default `80` | Warning threshold in percent; `null` for no warning |
| `action` | enum | no | `alert` / `maintenance` / `disable`, default `maintenance` | At 100%: alert only, maintenance mode, disable the site |
| `recovery` | enum | no | `auto` / `manual`, default `auto` | `auto`: the action is lifted once the period is no longer over a limit (next period, a higher limit, or bandwidth after its hold time); `manual`: only by restoring |
| `bandwidthHoldMinutes` | integer | no | 5–1440, default `30` | With `auto`, how long an action for bandwidth holds after the last time it was over |

### Usage protection object

| Field | Type | Description |
| --- | --- | --- |
| `siteId` | uuid | Site ID |
| `settings` | [Usage protection settings](#usage-protection-settings) | Settings; `null` when not set |
| `updatedAt` | datetime | Updated, or `null` |
| `period` | object | The current period `{ start, end }` (datetime); `null` when not set |
| `usage` | object | Usage of the current period `{ bytes, requests, bandwidthBps, bandwidthPeakBps }`: `bytes`, `requests` are decimal strings; `bandwidthBps` is the average of the last 5 complete minutes, `bandwidthPeakBps` the highest of the period (number, bit/s); `null` when not set |
| `held` | object | The action usage protection applied and still holds `{ action, metric, since }`: `action` `maintenance` / `disable`, `metric` `bytes` / `requests` / `bandwidth`; `null` when none |
| `pausedUntil` | datetime | After a restore, no action until then (the end of that period), or `null` |
| `lastError` | string | Error code of the last action that could not be published; empty when none |

### Automatic mitigation object

| Field | Type | Description |
| --- | --- | --- |
| `siteId` | uuid | Site ID |
| `settings` | object | `{ enabled, threshold, durationMinutes }`; `null` when never set up (off) |
| `updatedAt` | datetime | Updated, or `null` |
| `level` | enum | The highest CC level any online node holds for the site now: `normal` / `cookie302` / `js` / `pow` / `captcha` |
| `active` | object | Under Attack as the mitigation turned it on and still holds it `{ since, expiresAt, level }`; `expiresAt` moves while the level stays at the threshold; `null` when none |
| `paused` | boolean | The operator took over: nothing starts until the level is below the threshold again |
| `lastError` | string | Error code of the last change that could not be published; empty when none |
