# API: Access control

Procedures for site rules, platform rules, bulk redirects, IP lists, the IP check, bans, the greylist, challenges and CC mitigation, and OWASP CRS.

Access levels, authentication, idempotency keys and the error format: [API overview](../api.en.md).

## Site rules

- Saving and restoring publish a configuration revision for the site's cluster (reason `rules_updated`) and audit `site.rules_update` and `site.rule_restore` (metadata: the rule count `count`; a restore also has the rule `{ id, name }` and `version`).
- Every save records a version for each rule it adds, changes or deletes; a change of order alone records none. Each rule keeps its last 50 versions; each site keeps its 100 most recently deleted rules.
- Rule object and actions: [Rule object](#rule-object), [Rule actions](#rule-actions). Expression language: [Expressions](../../guide/rules.en.md#expressions). Behavior: [Rules, IP lists, and GeoIP](../../guide/rules.en.md).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`rules.get`](#rulesget) | `GET /sites/{id}/rules` | read |
| [`rules.save`](#rulessave) | `PUT /sites/{id}/rules` | write |
| [`rules.versions`](#rulesversions) | `GET /sites/{id}/rules/{ruleId}/versions` | read |
| [`rules.deleted`](#rulesdeleted) | `GET /sites/{id}/rules/deleted` | read |
| [`rules.restore`](#rulesrestore) | `POST /sites/{id}/rules/{ruleId}/restore` | write |
| [`rules.topLogged`](#rulestoplogged) | `GET /sites/{id}/rules/logged` | read |
| [`rules.validate`](#rulesvalidate) | `POST /rules/validate` | read |

### `rules.get`

`GET /sites/{id}/rules` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |

Response: [Rule](#rule-object)[], in saved order.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `rules.save`

`PUT /sites/{id}/rules` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `rules` | body | array<[Rule](#rule-object)> | yes | At most 64; the `banScope` of a `ban` action must be `site` | Replaces all of the site's rules; they run in array order |

A rule's `id` is kept when it is the ID of one of the site's rules; otherwise (omitted, or from another site) a new one is generated.

Response: the saved [Rule](#rule-object)[], with `id`.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |
| `RULE_INVALID` | 400 | Two rules have the same `id`; the `originGroup` of an `origin` action is not one of the site's origin groups; the site's saved rules or cache rule conditions do not compile |
| `ORIGIN_HOST_HEADER_INVALID` | 400 | The `hostHeader` of an `origin` action is not a host name or IP the nodes accept; `data.hostHeader` |
| `IP_LIST_REFERENCE_UNKNOWN` | 404 | An expression refers to an IP list that does not exist; `data.lists` holds the first 5 names, comma-separated |

### `rules.versions`

`GET /sites/{id}/rules/{ruleId}/versions` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `ruleId` | path | uuid | yes | — | Rule ID, deleted rules included |

Response: [Rule version](#rule-version-object)[], highest version first. Empty when the rule is not the site's or has no versions.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `rules.deleted`

`GET /sites/{id}/rules/deleted` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |

Response: [Rule version](#rule-version-object)[], the last version of each deleted rule (`change` is `deleted`, `rule` is the content before deletion), most recently deleted first.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `rules.restore`

`POST /sites/{id}/rules/{ruleId}/restore` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `ruleId` | path | uuid | yes | — | Rule ID |
| `version` | body | integer | yes | ≥1 | A kept version number of the rule |

Saves the version as the rule: in place when the rule exists; when it was deleted, under its old `id` after the last rule of its phase (at the end when the phase has no rules). The version is checked against today's rule checks. The new version has `source` `restore` and `restoredFrom` `version`.

Response: all of the site's [Rule](#rule-object)[] after the restore.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |
| `RULE_VERSION_NOT_FOUND` | 404 | The site keeps no such version of the rule (pruned, or another site's rule) |
| `RULE_INVALID` | 400 | The version no longer passes the rule checks; the rule ID is used by another rule; the origin group does not exist; the site's saved rules do not compile |
| `RULE_LIMIT_REACHED` | 400 | Restoring a deleted rule would exceed 64 rules; `data.limit` |
| `ORIGIN_HOST_HEADER_INVALID` | 400 | The `hostHeader` of an `origin` action is invalid; `data.hostHeader` |
| `IP_LIST_REFERENCE_UNKNOWN` | 404 | An expression refers to an IP list that does not exist; `data.lists` |

### `rules.topLogged`

`GET /sites/{id}/rules/logged` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `range` | query | enum | no | `1h` / `6h` / `24h` / `7d` / `30d`, default `24h` | Time range |
| `limit` | query | integer | no | 1–50, default `10` | Rules returned |

Requests matched by `log` actions of the site's rules and of platform rules, from the nodes' per-minute counters (at most 20 rules per node, site and minute); approximate.

Response: `{ approximate: true, items, unsupportedNodes }`.

| Field | Type | Description |
| --- | --- | --- |
| `items[].ruleId` | uuid | Rule ID |
| `items[].name` | string or `null` | The rule's current name; `null` once the rule is deleted |
| `items[].platform` | boolean | A platform rule |
| `items[].requests` | number | Matched requests, sorted descending |
| `unsupportedNodes` | integer | Active nodes of the site's cluster that do not count matches (no node capability `rule-log-v1`) |

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `rules.validate`

`POST /rules/validate` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `expression` | body | string | yes | At most 16384 characters | The expression to check |
| `phase` | body | enum | yes | A rule phase, see [Rule object](#rule-object) | The phase the expression belongs to; ignored for `kind` `cacheRule` but still required |
| `kind` | body | enum | no | `condition` / `value` / `cacheRule`, default `condition` | `condition`: a rule condition; `value`: a value expression (redirect target, rewrite path, request or response header value, query parameter value); `cacheRule`: a cache rule condition |

Response:

| Field | Type | Description |
| --- | --- | --- |
| `valid` | boolean | Whether the expression is valid |
| `position` | integer | Character offset of the error (from 0); `0` when valid |
| `message` | string | Reason in English; empty when valid |
| `code` | enum | Invalid only: a stable reason code such as `unknown_field`, `expected_token`, `ordered_comparison`; every value is listed in the OpenAPI document |
| `params` | object | Invalid only: the values the reason names (string to string), such as `token` for `expected_token` |

## Platform rules

Platform rules apply to every site of every cluster and run before the site rules in each phase.

- Saving and restoring publish a configuration revision for every cluster (reason `rules_updated`) and audit `platform.rules_update` and `platform.rule_restore`.
- Versions are kept as for [site rules](#site-rules): 50 versions per rule, the 100 most recently deleted rules.

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`platformRules.get`](#platformrulesget) | `GET /platform-rules` | read |
| [`platformRules.save`](#platformrulessave) | `PUT /platform-rules` | write |
| [`platformRules.versions`](#platformrulesversions) | `GET /platform-rules/{ruleId}/versions` | read |
| [`platformRules.deleted`](#platformrulesdeleted) | `GET /platform-rules/deleted` | read |
| [`platformRules.restore`](#platformrulesrestore) | `POST /platform-rules/{ruleId}/restore` | write |

### `platformRules.get`

`GET /platform-rules` · read

No parameters.

Response: [Rule](#rule-object)[], in saved order.

### `platformRules.save`

`PUT /platform-rules` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `rules` | body | array<[Rule](#rule-object)> | yes | At most 32 | Replaces all platform rules |

A rule's `id` is kept when it is the ID of an existing platform rule; otherwise a new one is generated. A `ban` action of a platform rule may use `banScope: "platform"`; an `origin` action cannot choose an origin group.

Response: the saved [Rule](#rule-object)[].

| Error | Status | Condition |
| --- | --- | --- |
| `RULE_INVALID` | 400 | Two rules have the same `id`; the `originGroup` of an `origin` action is not empty |
| `ORIGIN_HOST_HEADER_INVALID` | 400 | The `hostHeader` of an `origin` action is invalid; `data.hostHeader` |
| `IP_LIST_REFERENCE_UNKNOWN` | 404 | An expression refers to an IP list that does not exist; `data.lists` |

### `platformRules.versions`

`GET /platform-rules/{ruleId}/versions` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `ruleId` | path | uuid | yes | — | Platform rule ID, deleted rules included |

Response: [Rule version](#rule-version-object)[], highest version first; empty for a rule that is not a platform rule.

### `platformRules.deleted`

`GET /platform-rules/deleted` · read

No parameters.

Response: [Rule version](#rule-version-object)[], the last version of each deleted platform rule, most recently deleted first.

### `platformRules.restore`

`POST /platform-rules/{ruleId}/restore` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `ruleId` | path | uuid | yes | — | Platform rule ID |
| `version` | body | integer | yes | ≥1 | A kept version number of the rule |

Works like [`rules.restore`](#rulesrestore), with a limit of 32 rules.

Response: all platform [Rule](#rule-object)[] after the restore.

| Error | Status | Condition |
| --- | --- | --- |
| `RULE_VERSION_NOT_FOUND` | 404 | No such platform rule version is kept |
| `RULE_INVALID` | 400 | The version no longer passes the rule checks; the rule ID is used by another rule |
| `RULE_LIMIT_REACHED` | 400 | Restoring a deleted rule would exceed 32 rules; `data.limit` |
| `ORIGIN_HOST_HEADER_INVALID` | 400 | The `hostHeader` of an `origin` action is invalid; `data.hostHeader` |
| `IP_LIST_REFERENCE_UNKNOWN` | 404 | An expression refers to an IP list that does not exist; `data.lists` |

## Bulk redirects

- Saving publishes a configuration revision for the site's cluster (reason `rules_updated`) and audits `site.bulk_redirects_update` (metadata `count`, `revision`).
- Bulk redirects need the node capability `rules-v2`. Behavior: [Bulk redirects](../../guide/rules.en.md#bulk-redirects).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`bulkRedirects.get`](#bulkredirectsget) | `GET /sites/{id}/bulk-redirects` | read |
| [`bulkRedirects.save`](#bulkredirectssave) | `PUT /sites/{id}/bulk-redirects` | write |

### `bulkRedirects.get`

`GET /sites/{id}/bulk-redirects` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |

Response: [Bulk redirect entry](#bulk-redirect-entry)[], in saved order.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `bulkRedirects.save`

`PUT /sites/{id}/bulk-redirects` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `redirects` | body | array<[Bulk redirect entry](#bulk-redirect-entry)> | yes | At most 5000; `source` unique | Replaces the site's redirect table |

Response: the saved [Bulk redirect entry](#bulk-redirect-entry)[].

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |
| `BULK_REDIRECT_HOST_UNKNOWN` | 400 | The host of a `host/path` source is neither an exact domain of the site nor one label under a wildcard domain of the site; `data.hosts` holds the first 5, comma-separated |

## IP lists

- Lists apply to every cluster: creating, changing and deleting one publishes a configuration revision for every cluster (reason `rules_updated`) and audits `ip_list.create`, `ip_list.update` (metadata: the entry count `entries`, `kind`) and `ip_list.delete`.
- Quota: at most 128 lists and 50000 entries in all; a change that does not add entries always fits.
- Behavior: [IP lists](../../guide/rules.en.md#ip-lists).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`ipLists.list`](#iplistslist) | `GET /ip-lists` | read |
| [`ipLists.create`](#iplistscreate) | `POST /ip-lists` | write |
| [`ipLists.update`](#iplistsupdate) | `PUT /ip-lists/{id}` | write |
| [`ipLists.delete`](#iplistsdelete) | `DELETE /ip-lists/{id}` | write |

### `ipLists.list`

`GET /ip-lists` · read

No parameters.

Response: [IP list](#ip-list-object)[], sorted by name.

### `ipLists.create`

`POST /ip-lists` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | body | string | yes | Starts with a letter or underscore, only letters, digits and underscores, 1–64 characters | Name, written `$name` in expressions; cannot be changed later |
| `entries` | body | `array<string>` | yes | At most 10000 IPv4 / IPv6 addresses or CIDRs of at most 64 characters each | Stored with host bits cleared, deduplicated and sorted; an invalid entry fails validation |
| `kind` | body | enum | no | `collection` / `allow` / `block`, default `collection` | `collection`: referenced by rules; `block`: a block list for every site; `allow`: an allow list for every site |

Response: [IP list](#ip-list-object).

| Error | Status | Condition |
| --- | --- | --- |
| `IP_LIST_NAME_TAKEN` | 409 | The name is in use |
| `IP_LIST_LIMIT` | 409 | The list or entry quota would be exceeded |

### `ipLists.update`

`PUT /ip-lists/{id}` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | List ID |
| `entries` | body | `array<string>` | yes | As for `ipLists.create` | Replaces all entries |
| `kind` | body | enum | yes | `collection` / `allow` / `block` | The list's action |

Response: [IP list](#ip-list-object).

| Error | Status | Condition |
| --- | --- | --- |
| `IP_LIST_NOT_FOUND` | 404 | The list does not exist |
| `IP_LIST_LIMIT` | 409 | The change adds entries and exceeds the entry quota |

### `ipLists.delete`

`DELETE /ip-lists/{id}` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | List ID |

Response: `{ ok: true }`.

| Error | Status | Condition |
| --- | --- | --- |
| `IP_LIST_NOT_FOUND` | 404 | The list does not exist |
| `IP_LIST_IN_USE` | 409 | Rules, cache rule conditions or L4 applications still refer to the list, or sites chose it as a site list; `data.users` holds the first 5 users, comma-separated (site rules as `rule name (site name)`) |

## IP check

What the console knows about an address: the IP lists that contain it, the active bans that cover it, and how each cluster's client address setting sees it; for a site, also the outcome of the edge's list and ban steps. GeoIP is not looked up. Behavior: [IP check](../../guide/access-control.en.md#ip-check).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`ipCheck.check`](#ipcheckcheck) | `GET /ip-check` | read |

### `ipCheck.check`

`GET /ip-check` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `ip` | query | string | yes | 1–64 characters after trimming; an IPv4 or IPv6 address, not a CIDR | The address to check |
| `siteId` | query | uuid | no | — | Site ID; with it, `bans` holds only platform bans and the site's, `clusters` only the site's cluster, and `verdict` is computed |

Response: [IP check result](#ip-check-result).

| Error | Status | Condition |
| --- | --- | --- |
| `IP_ADDRESS_INVALID` | 400 | `ip` is not an IP address, or is a CIDR |
| `SITE_NOT_FOUND` | 404 | The site of `siteId` does not exist |

## Bans

- Bans reach the nodes over the node channel within seconds, without a configuration revision. Audit: `ban.create`, `ban.update` (banning an active manual ban again), `ban.delete`.
- Active manual bans and greylist entries together stay within the platform limit (`maxTotal` of `settings.bans`, default 10000).
- Behavior: [Bans](../../guide/bans.en.md).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`bans.list`](#banslist) | `GET /bans` | read |
| [`bans.create`](#banscreate) | `POST /bans` | write |
| [`bans.delete`](#bansdelete) | `DELETE /bans/{id}` | write |

### `bans.list`

`GET /bans` · read

Active bans only (neither expired nor lifted), newest first.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `scope` | query | enum | no | `site` / `platform` | Scope |
| `siteId` | query | uuid | no | — | Only the site's bans; the site's existence is not checked |
| `source` | query | enum | no | `manual` / `auto` / `rule` | Source |
| `address` | query | string | no | 1–64 characters after trimming; an IP address or a CIDR of any prefix length | Only bans that cover it or lie inside it |
| `page` | query | integer | no | ≥1, default `1` | Page |
| `pageSize` | query | integer | no | 1–100, default `50` | Items per page |

Response: `{ items: [Ban](#ban-object)[], total }`.

| Error | Status | Condition |
| --- | --- | --- |
| `BAN_INVALID_CIDR` | 400 | `address` is not an IP address or CIDR |

### `bans.create`

`POST /bans` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `scope` | body | enum | yes | `site` / `platform` | `site`: one site; `platform`: every site of every cluster |
| `siteId` | body | uuid | conditional | Required when `scope` is `site`, not allowed when it is `platform` | Site ID |
| `cidr` | body | string | yes | 1–64 characters after trimming; an IP address or CIDR with a prefix of at least `/16` (IPv4) or `/48` (IPv6) | Stored with host bits cleared, IPv6 lowercase and compressed, IPv4-mapped addresses as IPv4 |
| `reason` | body | enum | yes | `abuse` / `attack` / `scanner` / `spam` / `other` | Reason |
| `durationSeconds` | body | integer | yes | 60–604800 | Duration in seconds |

When an active manual ban of the same scope, site and CIDR exists, its `reason` and expiry are updated and the same `id` is returned; it does not count against the limit and is audited `ban.update`. An automatic or rule ban of the same CIDR at platform scope is replaced by this manual ban.

Response: [Ban](#ban-object).

| Error | Status | Condition |
| --- | --- | --- |
| `BAN_INVALID_CIDR` | 400 | `cidr` is not an IP address or CIDR |
| `BAN_PREFIX_TOO_SHORT` | 400 | The prefix is shorter than `/16` (IPv4) or `/48` (IPv6); `data.min` |
| `BAN_EXPIRY_OUT_OF_RANGE` | 400 | `durationSeconds` is outside 60–604800 |
| `BAN_PROTECTED_ADDRESS` | 400 | The ban covers loopback or unspecified addresses (`0.0.0.0/8`, `127.0.0.0/8`, `::/128`, `::1/128`), node addresses (site ban: nodes of the site's cluster; platform ban: every node) or entries of allow lists; `data.address` is the conflicting address |
| `BAN_PLATFORM_LIMIT` | 409 | Active manual bans and greylist entries have reached the limit; `data.limit` |
| `SITE_NOT_FOUND` | 404 | The site of `siteId` does not exist |

### `bans.delete`

`DELETE /bans/{id}` · write

Lifts an active ban of any source (manual, automatic or rule).

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Ban ID |

Response: `{ ok: true }`.

| Error | Status | Condition |
| --- | --- | --- |
| `BAN_NOT_FOUND` | 404 | The ban does not exist, has expired or was lifted |

## Greylist

- Greylist entries share the bans' node channel, address rules, duration range, reasons and limit of manual entries; a ban of the same CIDR is a separate record and wins while both last.
- Creating or updating an entry whose action is a challenge publishes the clusters it applies to (every cluster for a platform entry; reason `greylist_challenge`) to deliver challenge keys; clusters whose configuration already carries them get no new revision.
- Audit: `greylist.create`, `greylist.update`, `greylist.delete`. Nodes need the capability `greylist-v1`. Behavior: [Greylist](../../guide/bans.en.md#greylist).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`greylist.list`](#greylistlist) | `GET /greylist` | read |
| [`greylist.create`](#greylistcreate) | `POST /greylist` | write |
| [`greylist.delete`](#greylistdelete) | `DELETE /greylist/{id}` | write |

### `greylist.list`

`GET /greylist` · read

Active entries only, newest first.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `scope` | query | enum | no | `site` / `platform` | Scope |
| `siteId` | query | uuid | no | — | Only the site's entries |
| `address` | query | string | no | 1–64 characters after trimming; an IP address or CIDR | Only entries that cover it or lie inside it |
| `page` | query | integer | no | ≥1, default `1` | Page |
| `pageSize` | query | integer | no | 1–100, default `50` | Items per page |

Response: `{ items: [Greylist entry](#greylist-entry-object)[], total, unsupportedNodes }`; `unsupportedNodes` counts the active nodes (of every cluster) without `greylist-v1`, which ignore every entry.

| Error | Status | Condition |
| --- | --- | --- |
| `BAN_INVALID_CIDR` | 400 | `address` is not an IP address or CIDR |

### `greylist.create`

`POST /greylist` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `scope` | body | enum | yes | `site` / `platform` | Scope |
| `siteId` | body | uuid | conditional | Required when `scope` is `site`, not allowed when it is `platform` | Site ID |
| `cidr` | body | string | yes | As for [`bans.create`](#banscreate) | IP address or CIDR |
| `reason` | body | enum | yes | `abuse` / `attack` / `scanner` / `spam` / `other` | Reason |
| `durationSeconds` | body | integer | yes | 60–604800 | Duration in seconds |
| `action` | body | object | yes | See [Greylist entry object](#greylist-entry-object) | `{ kind: "challenge", challenge }` or `{ kind: "rate_limit", requests, windowSeconds }` |

When an active entry of the same scope, site and CIDR exists, its `action`, `reason` and expiry are updated and the same `id` is returned; it does not count against the limit and is audited `greylist.update`.

Response: [Greylist entry](#greylist-entry-object).

| Error | Status | Condition |
| --- | --- | --- |
| `BAN_INVALID_CIDR` | 400 | `cidr` is not an IP address or CIDR |
| `BAN_PREFIX_TOO_SHORT` | 400 | The prefix is shorter than `/16` (IPv4) or `/48` (IPv6); `data.min` |
| `BAN_EXPIRY_OUT_OF_RANGE` | 400 | `durationSeconds` is outside 60–604800 |
| `BAN_PROTECTED_ADDRESS` | 400 | The entry covers a protected address, as for [`bans.create`](#banscreate); `data.address` |
| `BAN_PLATFORM_LIMIT` | 409 | Active manual bans and greylist entries have reached the limit; `data.limit` |
| `SITE_NOT_FOUND` | 404 | The site of `siteId` does not exist |

### `greylist.delete`

`DELETE /greylist/{id}` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Entry ID |

Response: `{ ok: true }`.

| Error | Status | Condition |
| --- | --- | --- |
| `BAN_NOT_FOUND` | 404 | The entry does not exist, has expired or was removed |

## Challenges and CC mitigation

- Challenge types are also levels, weakest first: `cookie302`, `js`, `pow`, `captcha`; CC levels add `normal`.
- A change publishes a configuration revision for the site's cluster (reason `site_protection_updated`) and audits `site.protection_update` (metadata `from`, `to`, `revision`).
- Node capabilities: Under Attack and CC need `challenge-v1`; `allowVerifiedBots`, `challengeText` and `failureBan` need `challenge-v2`; `logJa4` needs `ja4-v1`.
- Platform Under Attack and the CC template are system settings (`settings.protection`, `settings.ccTemplate`). Behavior: [Challenges and CC mitigation](../../guide/challenges.en.md).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`protection.get`](#protectionget) | `GET /sites/{id}/protection` | read |
| [`protection.update`](#protectionupdate) | `PATCH /sites/{id}/protection` | write |
| [`security.state`](#securitystate) | `GET /sites/{id}/security` | read |
| [`security.events`](#securityevents) | `GET /sites/{id}/security/events` | read |

### `protection.get`

`GET /sites/{id}/protection` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |

Response: [Site protection](#site-protection-object). A site never saved returns the defaults with `updatedAt` `null`.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `protection.update`

`PATCH /sites/{id}/protection` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `underAttack` | body | boolean | no | Unchanged when omitted | The site's Under Attack |
| `underAttackChallenge` | body | enum | no | `cookie302` / `js` / `pow` / `captcha`; unchanged when omitted | Challenge type of Under Attack |
| `passTtlSeconds` | body | integer | no | 300–86400; unchanged when omitted | Pass lifetime in seconds |
| `powDifficulty` | body | integer | no | 8–24; unchanged when omitted | Proof-of-work difficulty (leading zero bits) |
| `powHighDifficulty` | body | integer | no | 8–26, at least `powDifficulty` after merging; unchanged when omitted | High-difficulty proof of work |
| `cc` | body | object | no | Any fields of [CC thresholds](#cc-thresholds-object), plus `enabled` and `followTemplate` (boolean); unchanged when omitted | Merged into the saved CC policy |
| `logJa4` | body | boolean | no | Unchanged when omitted | Record JA4 in sampled access logs |
| `allowVerifiedBots` | body | boolean | no | Unchanged when omitted | Verified search engine crawlers skip Under Attack and CC challenges |
| `challengeText` | body | object | no | `titleZh`, `hintZh`, `titleEn`, `hintEn`, each at most 200 characters after trimming, no control characters; an omitted subfield is `""`; unchanged when omitted | Replaces the challenge pages' title and hint; `""` is the built-in text |
| `failureBan` | body | object | no | `{ enabled, threshold, banSeconds }`, all required: `threshold` 3–100, `banSeconds` 60–86400; unchanged when omitted | After `threshold` challenge failures within 10 minutes, ban the address for `banSeconds` |

- With `cc.followTemplate` `true` the thresholds are the platform CC template's; threshold fields sent along are saved but not used.
- Sending `underAttack` counts as a manual change: while [automatic mitigation](../../guide/attack-dashboard.en.md#automatic-mitigation) holds Under Attack on the site, turning it on takes it over and turning it off ends the hold and pauses automatic mitigation.

Response: [Site protection](#site-protection-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |
| `PROTECTION_POW_DIFFICULTY` | 400 | After merging, `powHighDifficulty` is below `powDifficulty`; `data.min` is the lowest allowed value |

### `security.state`

`GET /sites/{id}/security` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `hours` | query | integer | no | 1–720, default `24` | Hours `topIps` and `topPaths` cover |

Response:

| Field | Type | Description |
| --- | --- | --- |
| `nodes` | `array<object>` | Each active node of the site's cluster, sorted by name |
| `nodes[].id`, `nodes[].name` | uuid, string | The node |
| `nodes[].online` | boolean | Whether the node is online |
| `nodes[].level` | enum | The site's CC level on the node: `normal` / `cookie302` / `js` / `pow` / `captcha`; `normal` when not reported |
| `nodes[].escalatedPaths` | integer | Paths challenged above the site's level |
| `nodes[].reportedAt` | datetime or `null` | When the node last connected |
| `topIps`, `topPaths` | array<`{ value, count }`> | Heaviest addresses and paths of the security events in the last `hours`, at most 10 each, approximate |
| `hours` | integer | The hours used |

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `security.events`

`GET /sites/{id}/security/events` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `kind` | query | enum | no | `site_level` / `path_level` / `ip_banned` | Event kind |
| `hours` | query | integer | no | 1–720; no limit when omitted | Only events of the last this many hours |
| `page` | query | integer | no | ≥1, default `1` | Page |
| `pageSize` | query | integer | no | 1–100, default `50` | Items per page |

Response: `{ items: [Security event](#security-event-object)[], total }`, newest first. Events are kept for `eventRetentionDays` of the system setting `settings.protection`.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### Managed challenge and CAPTCHA providers

| Field | Notes |
| --- | --- |
| `underAttackChallenge` | Site and global also accept `managed` (managed challenge); CC levels and the greylist do not |
| `interactiveProvider` | `PATCH /sites/{id}/protection`: `global` (default, follows the global provider), `builtin` (built-in image captcha), `site` (the site's `provider`) |
| `provider` | The site's provider in `PATCH /sites/{id}/protection`, the global one in `PUT /settings/protection`: `kind` (`builtin`, `turnstile`, `recaptcha_v2`, `recaptcha_v3`, `recaptcha_enterprise`, `tencent`, `aliyun`, `geetest`), `siteKey` (1–128 letters, digits, `_.-`; required except for `builtin`), `minScore` (1–100, default 50; `recaptcha_v3` and `recaptcha_enterprise`), `projectId` (required for `recaptcha_enterprise`), `region` (`cn` / `sgp`) and `prefix` (`aliyun`, `prefix` required), `secret` (see below; fields left out keep the saved values of the same kind) |
| Responses | `protection.*` add `interactiveProvider`, `provider`, `globalProvider`; `settings.protection` adds `provider`: `{ kind, siteKey, minScore, projectId, region, prefix, secretSet, updatedAt }`, never the secrets |

| `kind` | `secret` fields |
| --- | --- |
| `turnstile`, `recaptcha_v2`, `recaptcha_v3` | `secret` |
| `recaptcha_enterprise` | `apiKey` |
| `tencent` | `secretId`, `secretKey`, `appSecretKey` |
| `aliyun` | `accessKeyId`, `accessKeySecret` |
| `geetest` | `captchaKey` |

| Error code | Status | When |
| --- | --- | --- |
| `CHALLENGE_PROVIDER_SECRET_REQUIRED` | 400 | A new provider, or a switch to `site`, without all secret fields; `data.fields` lists the missing ones |

The managed challenge, `interactiveProvider` `site`, and a global provider other than `builtin` need the node capability `challenge-v3`. A change of the global provider publishes the clusters with sites that follow it (`platform_protection_updated`) and is audited as `system.protection_update` without the secrets.

```bash
curl -fsS -X PATCH -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"interactiveProvider":"site","provider":{"kind":"turnstile","siteKey":"<site key>","secret":{"secret":"<secret key>"}}}' \
  https://cdn-admin.example.com/api/v1/sites/<site ID>/protection
```

## OWASP CRS

- A change publishes a configuration revision for the site's cluster (reason `site_waf_updated`) and audits `site.waf_update` (metadata `from`, `to`, `revision`).
- Node capabilities: turning CRS on needs `modsecurity-v1`; exclusions with `path` or `targets` need `waf-v2`.
- Behavior: [OWASP CRS managed rules](../../guide/waf.en.md).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`waf.get`](#wafget) | `GET /sites/{id}/waf` | read |
| [`waf.update`](#wafupdate) | `PATCH /sites/{id}/waf` | write |
| [`waf.topRules`](#waftoprules) | `GET /sites/{id}/waf/rules` | read |

### `waf.get`

`GET /sites/{id}/waf` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |

Response: [Site CRS](#site-crs-object). Never saved: the defaults `mode` `off`, `paranoiaLevel` `1`, `anomalyThreshold` `5`, `exclusions` `[]`, `requestBodyLimit` `131072`, with `updatedAt` `null`.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `waf.update`

`PATCH /sites/{id}/waf` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `mode` | body | enum | no | `off` / `detect` / `block`; unchanged when omitted | `detect` logs matches only; `block` answers 403 once the anomaly score reaches the threshold |
| `paranoiaLevel` | body | integer | no | 1–4; unchanged when omitted | Paranoia level |
| `anomalyThreshold` | body | integer | no | 1–1000; unchanged when omitted | Inbound anomaly score threshold |
| `exclusions` | body | array<[CRS exclusion](#crs-exclusion)> | no | At most 100; unchanged when omitted | Replaces every exclusion |
| `requestBodyLimit` | body | integer | no | 0–134217728; unchanged when omitted | Request body bytes inspected; `0` inspects no body |

Response: [Site CRS](#site-crs-object).

| Error | Status | Condition |
| --- | --- | --- |
| `WAF_RULE_NOT_EXCLUDABLE` | 400 | `ruleIds` contains setup or evaluation rules (901xxx, 949xxx, 959xxx, 980xxx); `data.ids` holds the first 5, comma-separated |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `waf.topRules`

`GET /sites/{id}/waf/rules` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Site ID |
| `range` | query | enum | no | `1h` / `6h` / `24h` / `7d` / `30d`, default `24h` | Time range |
| `limit` | query | integer | no | 1–50, default `10` | Rules returned |

Response: `{ approximate: true, items: [{ ruleId, requests }] }`, most matched first, approximate; detection rules only, without 901xxx, 949xxx, 959xxx and 980xxx.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

## Objects

### Rule object

In requests `id` may be omitted; omitted fields take their defaults, and responses carry every field.

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Rule ID; optional in requests |
| `name` | string | 1–100 characters after trimming |
| `phase` | enum | `request-transform`, `redirect`, `config`, `waf-custom`, `ratelimit`, `cache`, `origin`, `response-transform`, `compression` |
| `expression` | string | Condition expression, 1–4096 characters, parsed for `phase`; syntax: [Expressions](../../guide/rules.en.md#expressions) |
| `enabled` | boolean | Default `false`: a rule saved without it is disabled |
| `action` | object | A [rule action](#rule-actions), told apart by `kind`; `kind` must be available in the phase |

An invalid expression or value expression returns 400 `BAD_REQUEST`; the issue's `params.expressionError` in `data.issues` is `{ code, position, params }`, as in the result of [`rules.validate`](#rulesvalidate).

### Rule actions

| `kind` | Phases | Fields | Node capability |
| --- | --- | --- | --- |
| `block` | `waf-custom` | `statusCode`: `403` (default) or `451` | — |
| `log` | `waf-custom` | `accessLog`: boolean, optional; write an access log line whatever the sample rate | `accessLog`: `waf-v2` |
| `allow` | `waf-custom` | None | — |
| `challenge` | `waf-custom` | `type`: `cookie302` / `js` (default) / `pow` / `captcha`; requests without a pass of this level or higher get the challenge | `challenge-v1` |
| `ban` | `waf-custom` | See [`ban`](#ban) | `waf-v2` |
| `respond` | `waf-custom` | See [`respond`](#respond) | `waf-v2` |
| `close` | `waf-custom` | None; closes the connection without a response | `waf-v2` |
| `skip` | `waf-custom` | `skip`: 1–4 unique values of `rules`, `rate_limits`, `crs`, `challenges` | `waf-v2` |
| `redirect` | `redirect` | See [`redirect`](#redirect) | See that section |
| `rewrite` | `request-transform` | See [`rewrite`](#rewrite) | See that section |
| `request_header` | `request-transform`, `origin` | See [`request_header` and `response_header`](#request_header-and-response_header) | See that section |
| `response_header` | `response-transform` | See [`request_header` and `response_header`](#request_header-and-response_header) | See that section |
| `config` | `config`, `cache` | See [`config`](#config) | See that section |
| `origin` | `origin` | See [`origin`](#origin) | `rules-v2` |
| `compression` | `compression` | `algorithms`: unique values of `zstd`, `br`, `gzip` in preference order; `[]` disables compression | `rules-v2` |
| `rate_limit` | `ratelimit` | See [`rate_limit`](#rate_limit) | See that section |

Targets of `skip`: `rules`, the remaining custom WAF rules of the rule's scope; `rate_limits`, rate limits (platform rules skip all of them, site rules only the site's); `crs`, OWASP CRS; `challenges`, Under Attack and CC challenges. Action behavior: [WAF actions](../../guide/rules.en.md#waf-actions) and [Action fields](../../guide/rules.en.md#action-fields); what needs which capability: [Node capabilities and publishing](../../guide/rules.en.md#node-capabilities-and-publishing).

#### `ban`

Bans `ip.src`, masked to the prefix (source `rule`, reason `waf_rule`), and answers this request with 403.

| Field | Type | Description |
| --- | --- | --- |
| `banSeconds` | integer | 60–604800, default `3600` |
| `banScope` | enum | `site` (default) / `platform`; `platform` for platform rules only |
| `banPrefixV4` | integer | 16–32, default `32` |
| `banPrefixV6` | integer | 48–64, default `64` |

#### `respond`

Ends the request with a status and a static body, or with the site's error page of the status; the response carries `Cache-Control: no-store`.

| Field | Type | Description |
| --- | --- | --- |
| `statusCode` | integer | `200`, `204` or 400–599, default `403` |
| `contentType` | enum | `text/plain` (default) / `text/html` / `application/json` |
| `body` | string | At most 8192 bytes, no control characters but tab and line breaks, default `""`; must be empty when `statusCode` is `204` or `errorPage` is `true` |
| `errorPage` | boolean | Default `false`; for 4xx and 5xx only |

#### `redirect`

Set exactly one of `value` and `target`.

| Field | Type | Description |
| --- | --- | --- |
| `value` | string | Static target, default `""`: a local path with a single leading `/`, or an `http(s)` URL without credentials, whitespace or backslashes; at most 4096 characters, no control characters |
| `target` | string | Value expression computing the target per request, at most 4096 characters, default `""` (`rules-v2`) |
| `statusCode` | integer | `301` (default), `302`, `303`, `307`, `308`; `303` needs `rules-v3` |
| `preserveQuery` | boolean | Default `false`; appends the request's query string to the target |
| `setQuery` | `array<object>` | At most 16 [query parameters](#query-parameter), names unique, default `[]`; set after removing parameters of the same name (`rules-v2`) |
| `removeQuery` | `array<string>` | At most 16 parameter names (`[A-Za-z0-9._~-]{1,64}`), none also in `setQuery`, default `[]` (`rules-v2`) |

#### `rewrite`

Rewrites the path and query string sent to the origin. Fields as for [`redirect`](#redirect), without `statusCode`; `value` is a path with a single leading `/` and no `?`, `#` or backslash; `preserveQuery` defaults to `true`, and `false` clears the query string before `setQuery` and `removeQuery` apply.

#### Query parameter

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | `[A-Za-z0-9._~-]{1,64}` |
| `value` | string | Printable ASCII, at most 256 characters; the node percent-encodes it |
| `expression` | string | Value expression, at most 4096 characters, default `""` (`rules-v3`); `value` must be empty when it is set |

#### `request_header` and `response_header`

| Field | Type | Description |
| --- | --- | --- |
| `header` | string | 1–64 token characters, lowercased; not `host`, `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `content-length`, `transfer-encoding`, `connection`, `upgrade`, `te`, `trailer` or `cdn-loop`, and not starting with `x-edgeweir-` |
| `value` | string | Static value, at most 4096 characters, no control characters, default `""` |
| `expression` | string | Value expression, at most 4096 characters, default `""` (`rules-v3`); when set, `value` must be empty and `remove` `false` |
| `remove` | boolean | Default `false`; removes the header |
| `append` | boolean | `response_header` only; default `false`, adds another line next to the response's own header of that name (`rules-v3`); cannot be `true` together with `remove` |

#### `config`

Overrides site settings for the requests the rule matches; later matching rules override field by field. Every field is optional and an omitted one is not overridden; set at least one. The `cache` phase accepts only `cacheBypass`, `forceHttps` and `gzip`.

| Field | Type | Description |
| --- | --- | --- |
| `cacheBypass` | boolean | Bypass the cache |
| `forceHttps` | boolean | Force HTTPS |
| `gzip` | boolean | Gzip (among the codings the site enables) |
| `brotli`, `zstd` | boolean | `config` phase only (`rules-v2`) |
| `websocket` | boolean | `config` phase only (`rules-v2`) |
| `underAttack` | boolean | The site's Under Attack; platform Under Attack is unaffected; `config` phase only (`rules-v2`) |
| `ccEnabled` | boolean | CC escalation; requests are counted either way; `config` phase only (`rules-v2`) |
| `ccMaxLevel` | enum | `cookie302` / `js` / `pow` / `captcha`; `config` phase only (`rules-v2`) |
| `originConnectTimeoutMs` | integer | 100–120000; `config` phase only (`rules-v2`) |
| `originSendTimeoutMs`, `originReadTimeoutMs` | integer | 100–3600000; `config` phase only (`rules-v2`) |
| `logSampleRate` | integer | Access log sample rate, 0–10000 basis points (`0` stops sampling); `config` phase only (`rules-v2`) |
| `requestBodyLimit` | integer | Request body limit by `Content-Length` in bytes, 0–10737418240, `0` for none; `config` phase only (`site-content-v1`) |
| `crs` | enum | The request's CRS mode: `off` / `detect` / `block`; sites without CRS ignore it; `config` phase only (`waf-v2`) |

#### `origin`

Set at least one override.

| Field | Type | Description |
| --- | --- | --- |
| `originGroup` | string | One of the site's origin groups, `""` (default) for the default group; otherwise `[a-z0-9_-]{1,32}` and an existing group of the site; platform rules only `""` |
| `hostHeader` | string | Host header sent upstream, trimmed, ASCII letters lowercased, at most 259 characters, default `""` (not overridden); a host name or IP with an optional port, IPv6 in brackets when it has a port |
| `sni` | string | TLS SNI host name, lowercased, at most 253 characters, default `""` (not overridden) |
| `port` | integer | 0–65535, default `0` (not overridden); applies to every origin of the group |

#### `rate_limit`

| Field | Type | Description |
| --- | --- | --- |
| `statusCode` | integer | `429` (default) or `403` |
| `limit` | integer | 1–100000, required |
| `windowSeconds` | integer | 1–3600, required |
| `key` | string | Counting key, default `ip.src`: `ip.src`, `http.host`, `tls.ja4` (`ja4-v1`) or `http.request.headers.<name>` (name `[a-z0-9-]{1,64}`) |
| `banSeconds` | integer | Optional; `0` is off, or 60–86400: ban the address over the limit at site scope (IPv4 /32, IPv6 /64, source `rule`, reason `rate_limit`) for this long (`waf-v2`) |

### Rule version object

| Field | Type | Description |
| --- | --- | --- |
| `ruleId` | uuid | Rule ID |
| `version` | integer | Version number, rising from 1 per rule |
| `change` | enum | `created` / `updated` / `deleted` |
| `source` | enum | `ui` (console session), `api` (AccessKey or service account), `restore`, `copy` (copied settings), `initial` (rules that existed before the upgrade) |
| `restoredFrom` | integer or `null` | The version a restore brought back |
| `rule` | object | The rule as saved, `{ name, phase, expression, enabled, action }`; for `deleted`, the content before deletion. Checked against today's rules only on restore |
| `actor` | object | `{ type, id, name }`: who saved |
| `createdAt` | datetime | When it was recorded |

### Bulk redirect entry

| Field | Type | Description |
| --- | --- | --- |
| `source` | string | `/path` (every domain of the site) or `host/path` (that domain only, lowercase host); 2–512 bytes without whitespace, `?` or control characters |
| `target` | string | Static redirect target: a local path with a single leading `/`, or an `http(s)` URL without credentials, whitespace or backslashes; at most 1024 bytes |
| `statusCode` | integer | `301` (default), `302`, `307`, `308` |
| `preserveQuery` | boolean | Default `false`; appends the request's query string to the target |

### IP list object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | List ID |
| `name` | string | Name |
| `entries` | `array<string>` | Canonical addresses and CIDRs, sorted |
| `kind` | enum | `collection` / `allow` / `block` |

### IP check result

| Field | Type | Description |
| --- | --- | --- |
| `ip` | string | The address as nodes read it (IPv4-mapped IPv6 as IPv4) |
| `site` | object or `null` | `{ id, name }`; `null` without `siteId` |
| `lists` | `array<object>` | Lists that contain the address, sorted by name |
| `lists[].id`, `lists[].name`, `lists[].kind` | uuid, string, enum | The list |
| `lists[].entries` | `array<string>` | The entries that contain the address |
| `lists[].siteRole` | enum or `null` | With `siteId`: the list is the site's site block list (`block`) or site allow list (`allow`); otherwise `null` |
| `bans` | array<[Ban](#ban-object)> | Active bans that cover the address, at most 100 |
| `clusters` | `array<object>` | Clusters, sorted by name |
| `clusters[].id`, `clusters[].name` | uuid, string | The cluster |
| `clusters[].clientIp` | enum | Client address mode: `direct` / `proxy_protocol` / `header` |
| `clusters[].trustedProxy` | boolean | In `header` mode, the address is a trusted proxy |
| `clusters[].nodeAddress` | boolean | The address is a node address of the cluster |
| `verdict` | object or `null` | With `siteId`, `{ outcome, platformAllowed, siteAllowed }`; otherwise `null` |
| `verdict.outcome` | enum | The first step of the edge that decides, in the edge's order: `platform_banned`, `site_banned`, `platform_blocked`, `site_blocked`, `allowed`, `none` |
| `verdict.platformAllowed` | boolean | The address is in an allow list |
| `verdict.siteAllowed` | boolean | The address is in a site allow list of the site |

### Ban object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Ban ID |
| `scope` | enum | `site` / `platform` |
| `cidr` | string | Canonical CIDR, such as `203.0.113.7/32` |
| `reason` | enum | Manual: `abuse`, `attack`, `scanner`, `spam`, `other`; automatic: `cc_ip_rate`, `unknown_host_scan`, `challenge_failures`; rule: `waf_rule`, `rate_limit` |
| `source` | enum | `manual` / `auto` / `rule` |
| `siteId`, `siteName` | uuid, string or `null` | `null` for platform bans |
| `node` | object or `null` | The node that made an automatic or rule ban, `{ id, name }` |
| `trigger` | object or `null` | `{ metric, observed, threshold, windowSeconds, ruleId? }`: what triggered it; `ruleId` is the rule of a rule ban |
| `rule` | object or `null` | The rule of a rule ban, `{ id, name, platform }`; `name` is `null` once the rule is deleted |
| `createdBy` | object or `null` | Who created a manual ban, `{ type, id, name }` |
| `createdAt`, `expiresAt` | datetime | Creation and expiry |
| `seq` | string | Position in the ban change sequence, a decimal string |
| `distributed` | boolean | Sent to the nodes; `false` for automatic bans not shared |
| `unappliedNodes` | integer | Online nodes that report this manual ban as not applied (no room) |

### Greylist entry object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Entry ID |
| `scope` | enum | `site` / `platform` |
| `cidr` | string | Canonical CIDR |
| `reason` | enum | `abuse` / `attack` / `scanner` / `spam` / `other` |
| `siteId`, `siteName` | uuid, string or `null` | `null` for platform entries |
| `action` | object | `{ kind: "challenge", challenge }`: `challenge` is `cookie302` / `js` / `pow` / `captcha`, and requests without a pass of that level get the challenge; or `{ kind: "rate_limit", requests, windowSeconds }`: each client (IPv4 address, IPv6 `/64`) may send `requests` requests (1–100000) per `windowSeconds` (1–3600), 429 above |
| `createdBy` | object or `null` | Who created it, `{ type, id, name }` |
| `createdAt`, `expiresAt` | datetime | Creation and expiry |
| `unappliedNodes` | integer | Online nodes that report this entry as not applied (no room) |

### Site protection object

| Field | Type | Description |
| --- | --- | --- |
| `siteId` | uuid | Site ID |
| `underAttack` | boolean | The site's Under Attack: GET / HEAD requests without a valid pass get a challenge; default `false` |
| `underAttackChallenge` | enum | Default `js` |
| `passTtlSeconds` | integer | Default `1800` |
| `powDifficulty` | integer | Default `16` |
| `powHighDifficulty` | integer | Default `20` |
| `cc` | object | The site's CC policy: [CC thresholds](#cc-thresholds-object) plus `enabled` (default `false`) and `followTemplate` (default `true`); while it follows the template the thresholds are the template's |
| `ccTemplate` | object | The platform's current [CC thresholds](#cc-thresholds-object) template |
| `effectiveCc` | object or `null` | The [CC thresholds](#cc-thresholds-object) the nodes use; `null` while the policy is off |
| `logJa4` | boolean | Default `false` |
| `allowVerifiedBots` | boolean | Default `false` |
| `challengeText` | object | `{ titleZh, hintZh, titleEn, hintEn }`; `""` is the built-in text |
| `failureBan` | object | `{ enabled, threshold, banSeconds }`; default `{ enabled: false, threshold: 10, banSeconds: 600 }`, the saved values are returned while it is off |
| `platformUnderAttack` | boolean | Whether platform Under Attack is on |
| `updatedAt` | datetime or `null` | Last saved; `null` when never saved |

### CC thresholds object

Every rate is in requests per second over a sliding window, and `0` turns its trigger off; each node decides on its own, so thresholds apply per node. The platform template's defaults are in parentheses.

| Field | Type | Description |
| --- | --- | --- |
| `maxLevel` | enum | Highest level reachable: `cookie302` / `js` / `pow` / `captcha` (`captcha`) |
| `highPowInsteadOfCaptcha` | boolean | At the `captcha` level, use the high-difficulty proof of work instead (`false`) |
| `windowSeconds` | integer | 5–60 (`10`) |
| `siteQps` | integer | 0–1000000 (`1000`) |
| `urlQps` | integer | 0–1000000; only attacked paths are escalated (`200`) |
| `ipQps` | integer | 0–1000000; addresses over it are banned automatically for `ipBanSeconds` (`50`) |
| `ipBanSeconds` | integer | 60–86400 (`600`) |
| `originErrorPercent` | integer | 0–100, origin errors (5xx and failed attempts) in percent of origin requests (`50`) |
| `originErrorMinRequests` | integer | 0–1000000, origin requests in the window before the error rate counts (`100`) |
| `escalateAfterSeconds` | integer | 1–3600; a trigger that holds this long raises the level one step (`10`) |
| `cooldownSeconds` | integer | 1–86400; without triggers for this long the level falls one step (`60`) |

### Security event object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Event ID |
| `node` | object or `null` | `{ id, name }`; `null` once the node is deleted |
| `occurredAt` | datetime | When it happened |
| `kind` | enum | `site_level` / `path_level` / `ip_banned` |
| `level`, `previousLevel` | string | Level after and before the change (`site_level`, `path_level`) |
| `path` | string | Path of a `path_level` event |
| `address` | string | Address of an `ip_banned` event |
| `metric` | string | `site_qps`, `url_qps`, `ip_qps`, `origin_error_rate` or `cooldown` |
| `observed`, `threshold` | number | Observed value and threshold |
| `topIps`, `topPaths` | array<`{ value, count }`> | Heaviest addresses and paths when it happened |

### Site CRS object

| Field | Type | Description |
| --- | --- | --- |
| `siteId` | uuid | Site ID |
| `mode` | enum | `off` / `detect` / `block` |
| `paranoiaLevel` | integer | Paranoia level |
| `anomalyThreshold` | integer | Inbound anomaly score threshold |
| `exclusions` | array<[CRS exclusion](#crs-exclusion)> | In saved order |
| `requestBodyLimit` | integer | Request body bytes inspected |
| `updatedAt` | datetime or `null` | Last saved |

### CRS exclusion

The rules do not run for the requests it matches; with `targets`, they only stop inspecting those targets. When saved, `ruleIds` are deduplicated and ascending, `targets` deduplicated and sorted, and `exact` is `false` when `path` is empty.

| Field | Type | Description |
| --- | --- | --- |
| `path` | string | `""` (default, the whole site) or a path starting with `/`, at most 1024 bytes, without `?`, `#`, whitespace or control characters; matched against the normalized path (`waf-v2`) |
| `exact` | boolean | Default `false` (prefix); `true` for an exact match |
| `ruleIds` | `array<integer>` | 1–200 unique CRS rule IDs (900000–999999), none of 901xxx, 949xxx, 959xxx, 980xxx |
| `targets` | `array<string>` | At most 16 unique targets, default `[]`: `ARGS:<name>`, `REQUEST_COOKIES:<name>` (name of 1–64 `A-Za-z0-9_.-[]`) or `REQUEST_HEADERS:<name>` (name of 1–64 `A-Za-z0-9-`) (`waf-v2`) |
