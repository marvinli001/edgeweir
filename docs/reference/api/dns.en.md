# API: DNS and scheduling

Procedures for DNS provider accounts, cluster DNS bindings and records, DNS revisions and reconciliation, regional probes and scheduling rules.

Access levels, authentication, idempotency keys and the error format: [API overview](../api.en.md).

## DNS providers

- Provider account credentials are stored encrypted; no procedure returns them.
- Audit actions: `dns.provider_create`, `dns.provider_update`, `dns.provider_delete`.
- Each console process runs at most 4 provider checks (`dns.zones`, `dns.testProvider`) at a time; beyond that 429 `DNS_PROVIDER_RATE_LIMITED`.
- Behaviour: [DNS steering: providers and credentials](../../guide/dns.en.md#providers-and-credentials); every provider and credential field: [Providers and credential fields](#providers-and-credential-fields).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`dns.catalog`](#dnscatalog) | `GET /dns/catalog` | read; service account (no scope) |
| [`dns.providers`](#dnsproviders) | `GET /dns/providers` | read |
| [`dns.createProvider`](#dnscreateprovider) | `POST /dns/providers` | write |
| [`dns.updateProvider`](#dnsupdateprovider) | `PUT /dns/providers/{id}` | write |
| [`dns.deleteProvider`](#dnsdeleteprovider) | `DELETE /dns/providers/{id}` | write |
| [`dns.zones`](#dnszones) | `POST /dns/zones` | write |
| [`dns.testProvider`](#dnstestprovider) | `POST /dns/test` | write |

### `dns.catalog`

`GET /dns/catalog` · read · service account (no scope)

No parameters.

Response: [DNS provider catalog object](#dns-provider-catalog-object)[], in the order of [Providers and credential fields](#providers-and-credential-fields). The catalog always contains `test`; it can be used only when `EDGEWEIR_DNS_TEST_ENDPOINT` is set.

### `dns.providers`

`GET /dns/providers` · read

No parameters.

Response: `{ items: `[DNS provider account](#dns-provider-account-object)`[], testEnabled }`. `items` are sorted by name; `testEnabled` is `true` when `EDGEWEIR_DNS_TEST_ENDPOINT` is set and the `test` provider can be used.

### `dns.createProvider`

`POST /dns/providers` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | body | string | yes | 1–100 characters after trimming | Account name |
| `provider` | body | enum | yes | A provider ID from [Providers and credential fields](#providers-and-credential-fields) | Provider |
| `zone` | body | string | yes | Domain name, lowercased, at most 253 characters, not starting with `*.` | Zone the account manages |
| `credentials` | body | object | yes | Keys at most 64 characters, values at most 16384 characters; checked against the provider's fields | Credentials, keyed by the field `key` |

`credentials` checks: only the provider's fields are accepted; required fields must not be empty; omitted or empty optional fields are not stored; `text`, `select` and `url` fields are trimmed; no control characters (`textarea` fields allow tabs and newlines); at most `maxLength`, matching `pattern` and `options`; `url` fields only `http` / `https`, without user info or fragment. Saving does not contact the provider.

Response: [DNS provider account](#dns-provider-account-object).

| Error | Status | Condition |
| --- | --- | --- |
| `DNS_POLICY_INVALID` | 400 | `credentials` fail the checks |
| `DNS_TEST_DISABLED` | 400 | `provider` is `test` and `EDGEWEIR_DNS_TEST_ENDPOINT` is not set |

### `dns.updateProvider`

`PUT /dns/providers/{id}` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Account ID |
| `name` | body | string | no | 1–100 characters after trimming; unchanged when omitted | Account name |
| `credentials` | body | object | no | As in `dns.createProvider`, checked against the account's existing provider; unchanged when omitted | New credentials, replacing the stored ones as a whole |

Provider and zone cannot be changed.

Response: [DNS provider account](#dns-provider-account-object).

| Error | Status | Condition |
| --- | --- | --- |
| `DNS_PROVIDER_NOT_FOUND` | 404 | The account does not exist |
| `DNS_POLICY_INVALID` | 400 | `credentials` fail the checks |
| `DNS_TEST_DISABLED` | 400 | The account's provider is `test` and `EDGEWEIR_DNS_TEST_ENDPOINT` is not set |

### `dns.deleteProvider`

`DELETE /dns/providers/{id}` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Account ID |

Response: `{ ok: true }`.

| Error | Status | Condition |
| --- | --- | --- |
| `DNS_PROVIDER_NOT_FOUND` | 404 | The account does not exist |
| `DNS_PROVIDER_IN_USE` | 409 | A cluster's DNS binding selects the account, or the account still holds records a cluster wrote |

### `dns.zones`

`POST /dns/zones` · write

Lists the zones the credentials can manage. The body takes one of two forms.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | body | uuid | form 1 | — | ID of a saved account, whose credentials are used |
| `provider` | body | enum | form 2 | Provider ID | Provider |
| `credentials` | body | object | form 2 | As in `dns.createProvider` | Unsaved credentials |

Response: `{ zones: string[] }`. Zone names are lowercased, without the trailing dot, deduplicated and sorted, at most 1000.

| Error | Status | Condition |
| --- | --- | --- |
| `DNS_PROVIDER_NOT_FOUND` | 404 | No account with `id` |
| `DNS_POLICY_INVALID` | 400 | `credentials` fail the checks |
| `DNS_TEST_DISABLED` | 400 | `provider` is `test` and `EDGEWEIR_DNS_TEST_ENDPOINT` is not set |
| `DNS_ZONES_UNSUPPORTED` | 400 | The provider cannot list zones (`capabilities.listZones` is `false`), or the provider refuses the operation |
| `DNS_PROVIDER_AUTH_FAILED` | 400 | The provider rejects the credentials |
| `DNS_ADDRESS_REFUSED` | 400 | A self-hosted endpoint's address is outside the outbound policy |
| `DNS_PROVIDER_RATE_LIMITED` | 429 | The provider rate-limits, or this process already runs 4 provider checks |
| `DNS_PROVIDER_UNREACHABLE` | 502 | The provider cannot be reached |
| `DNS_PROVIDER_FAILED` | 502 | Any other failed provider request |

### `dns.testProvider`

`POST /dns/test` · write

Reads the zone's records with the credentials (connection test); writes nothing. The body takes one of two forms.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | body | uuid | form 1 | — | ID of a saved account, whose credentials and zone are used |
| `provider` | body | enum | form 2 | Provider ID | Provider |
| `credentials` | body | object | form 2 | As in `dns.createProvider` | Unsaved credentials |
| `zone` | body | string | form 2 | As `zone` in `dns.createProvider` | Zone |

Response: `{ ok: true, records }`. `records` is the number of records read from the zone.

| Error | Status | Condition |
| --- | --- | --- |
| `DNS_PROVIDER_NOT_FOUND` | 404 | No account with `id` |
| `DNS_POLICY_INVALID` | 400 | `credentials` fail the checks |
| `DNS_TEST_DISABLED` | 400 | `provider` is `test` and `EDGEWEIR_DNS_TEST_ENDPOINT` is not set |
| `DNS_PROVIDER_AUTH_FAILED` | 400 | The provider rejects the credentials |
| `DNS_PROVIDER_ZONE_NOT_FOUND` | 400 | The provider has no such zone |
| `DNS_ADDRESS_REFUSED` | 400 | A self-hosted endpoint's address is outside the outbound policy |
| `DNS_ZONES_UNSUPPORTED` | 400 | The provider does not support the operation |
| `DNS_PROVIDER_RATE_LIMITED` | 429 | The provider rate-limits, or this process already runs 4 provider checks |
| `DNS_PROVIDER_UNREACHABLE` | 502 | The provider cannot be reached |
| `DNS_PROVIDER_FAILED` | 502 | Any other failed provider request |

## DNS bindings and records

- Each cluster has one DNS binding; `mode` is `off` (not managed), `manual` (records created by hand) or `auto` (written through a provider account). A cluster that never saved one returns `off` with TTL 600.
- Saving a binding publishes a DNS revision (reason `manual`), no node configuration revision; audit action `dns.binding_update`.
- Record names are relative to the zone (`@` for the apex) in revisions and in `dns.binding`, and absolute in `dns.exportBinding`.
- Behaviour: [DNS steering: bind a cluster](../../guide/dns.en.md#bind-a-cluster), [binding fields](../../guide/dns.en.md#binding-fields), [generated records](../../guide/dns.en.md#generated-records) and [manual mode](../../guide/dns.en.md#manual-mode).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`dns.bindings`](#dnsbindings) | `GET /dns/bindings` | read |
| [`dns.binding`](#dnsbinding) | `GET /clusters/{clusterId}/dns` | read |
| [`dns.saveBinding`](#dnssavebinding) | `PUT /clusters/{clusterId}/dns` | write |
| [`dns.exportBinding`](#dnsexportbinding) | `GET /clusters/{clusterId}/dns/export` | read |
| [`dns.siteTarget`](#dnssitetarget) | `GET /sites/{siteId}/cname` | read; service account `sites:read` |

### `dns.bindings`

`GET /dns/bindings` · read

No parameters.

Response: one item per cluster, sorted by cluster name.

| Field | Type | Description |
| --- | --- | --- |
| `clusterId` | uuid | Cluster ID |
| `clusterName` | string | Cluster name |
| `mode` | enum | `off` / `manual` / `auto` |
| `providerId` | uuid | Provider account ID, or `null` |
| `zone` | string | The account's zone; empty string without an account |
| `domain` | string | Parent name of the cluster's records; empty string when not set |
| `revision` | [DNS revision](#dns-revision-object) | Target revision, or `null` |
| `applied` | boolean | The target revision is written and read back |
| `blocked` | boolean | A revision is held back by the mass removal protection |

### `dns.binding`

`GET /clusters/{clusterId}/dns` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | yes | — | Cluster ID |

Response:

| Field | Type | Description |
| --- | --- | --- |
| `binding` | [DNS binding](#dns-binding-object) | The saved binding |
| `revision` | [DNS revision](#dns-revision-object) | Target revision, or `null` |
| `applied` | boolean | The target revision is written and read back |
| `records` | [DNS record](#dns-record-object)[] | Records of the target revision; `[]` without a revision |
| `blocked` | object | The latest revision held back by the mass removal protection, or `null`: the fields of a [DNS revision](#dns-revision-object) plus `removedRecords` (integer, address records it would remove) and `previousRecords` (integer, address records in the target revision) |

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |

### `dns.saveBinding`

`PUT /clusters/{clusterId}/dns` · write

Replaces the cluster's binding as a whole and publishes a DNS revision.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | yes | — | Cluster ID |
| `binding` | body | object | yes | — | Binding |
| `binding.mode` | body | enum | no | `off` / `manual` / `auto`, default `off` | Management mode |
| `binding.providerId` | body | uuid | no | Default `null`; required for `auto` | Provider account ID, or `null` |
| `binding.domain` | body | string | no | Empty string or a domain name (lowercased, not starting with `*.`), at most 180 characters, default `""`; required unless `mode` is `off`; with an account, the account's zone or a name below it | Parent name of the cluster's records; a site's target is `<CNAME prefix>.<domain>` |
| `binding.ttl` | body | integer | no | 30–3600, default `600` | Record TTL (seconds) |
| `binding.lines` | body | `array<object>` | no | At most 128 [DNS lines](#dns-line-object), default `[]`; `name` unique, `nodeGroupId` unique | Lines |
| `binding.lineAliases` | body | boolean | no | Default `false` | Also keep `<line name>.<CNAME prefix>.<domain>` for every site |

With `mode` `off`, the provider account, node groups, resolution lines and name conflicts are not checked.

Response: the published [DNS revision](#dns-revision-object), or `null`. When the records equal the target revision's, the target revision; when the mass removal protection holds the plan back, the target revision still in effect, or the held-back revision when there is none.

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |
| `DNS_PROVIDER_NOT_FOUND` | 404 | No account with `providerId` |
| `NODE_GROUP_NOT_FOUND` | 404 | A line's `nodeGroupId` or `backupNodeGroupIds` is not a node group of this cluster |
| `DNS_ZONE_MISMATCH` | 400 | `domain` is outside the account's zone |
| `DNS_LINE_UNSUPPORTED` | 400 | A line's `resolutionLine` is not among the lines the account's provider supports; `data.line` |
| `DNS_POLICY_INVALID` | 400 | A line name equals the all-lines record name (`allLabel`); in `overrides` a duplicate node, a node outside the line's node group, or an address that is not unicast; more than 10000 managed records |
| `DNS_BINDING_CONFLICT` | 409 | Another cluster's binding in the same zone and `domain` uses the same all-lines record name or line name, or a site's or layer-4 application's CNAME prefix (including a replaced prefix still in its transition period) uses the name; `data.name` |

### `dns.exportBinding`

`GET /clusters/{clusterId}/dns/export` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | yes | — | Cluster ID |

Response:

| Field | Type | Description |
| --- | --- | --- |
| `origin` | string | Zone: the account's zone, or `domain` without an account; empty string when neither is set |
| `records` | [DNS record](#dns-record-object)[] | Records with absolute names. `manual`: records computed from the current state; `auto`: records of the target revision; `off`: `[]` |
| `zoneFile` | string | BIND zone file: `$ORIGIN`, `$TTL` and the default line's records; records of other resolution lines follow as comments after `; line <line>`; empty string when `origin` is empty |

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |

### `dns.siteTarget`

`GET /sites/{siteId}/cname` · read · service account `sites:read`

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `siteId` | path | uuid | yes | — | Site ID |

Response:

| Field | Type | Description |
| --- | --- | --- |
| `target` | string | The site's CNAME target `<CNAME prefix>.<domain>`; `null` when the cluster's binding is `off` or has no `domain` |
| `mode` | enum | `off` / `manual` / `auto` |
| `published` | boolean | Can be `true` only for `auto`: the target revision is written and has a CNAME record for the target on the default line |
| `healthy` | boolean | Can be `true` only for `auto`: the target revision's all-lines record has address records |
| `lines` | `array<object>` | Per line `{ name, target }`: with `lineAliases` `target` is `<line name>.<CNAME prefix>.<domain>`, otherwise `<line name>.<domain>`; `[]` for `off` |
| `retired` | `array<object>` | Old names that keep resolving after a CNAME prefix change, `{ name, expiresAt }` (`expiresAt` a datetime); `[]` for `off` |

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

## DNS revisions and reconciliation

- Each DNS revision is the complete record set of one publication; revision numbers increase and are unique across all clusters. Each cluster keeps its newest 200 revisions; the target, applied and held-back revisions are never deleted.
- Mass removal protection: when a publication would remove a larger share of the previous revision's address records than `massRemovalRatio`, or would empty a record set that is still managed, the new revision is stored as `blocked`, the previous revision stays in effect, and the alert `dns_mass_removal_blocked` fires.
- Audit actions: `dns.rollback`, `dns.force_publish`, `dns.protection_update`; `dns.applied` when a revision has been written.
- Behaviour: [DNS steering: mass removal protection](../../guide/dns.en.md#mass-removal-protection), [DNS revisions and rollback](../../guide/dns.en.md#dns-revisions-and-rollback) and [health removal and repair](../../guide/dns.en.md#health-removal-and-repair).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`dns.bindingRevisions`](#dnsbindingrevisions) | `GET /clusters/{clusterId}/dns/revisions` | read |
| [`dns.rollbackBinding`](#dnsrollbackbinding) | `POST /clusters/{clusterId}/dns/revisions/{revision}/rollback` | write |
| [`dns.forcePublishBinding`](#dnsforcepublishbinding) | `POST /clusters/{clusterId}/dns/force-publish` | write |
| [`dns.protection`](#dnsprotection) | `GET /dns/protection` | read |
| [`dns.setProtection`](#dnssetprotection) | `PUT /dns/protection` | write |
| [`dns.reconcile`](#dnsreconcile) | `POST /dns/reconcile` | write |

### `dns.bindingRevisions`

`GET /clusters/{clusterId}/dns/revisions` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | yes | — | Cluster ID |

Response: [DNS revision](#dns-revision-object)[], newest first, at most 200.

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |

### `dns.rollbackBinding`

`POST /clusters/{clusterId}/dns/revisions/{revision}/rollback` · write

Restores the binding settings saved with the revision and publishes a new revision with reason `rollback`; addresses follow the nodes' current health.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | yes | — | Cluster ID |
| `revision` | path | integer | yes | ≥1 | Revision to restore |

Response: the new [DNS revision](#dns-revision-object). When the mass removal protection holds it back, the revision still in effect, or the held-back revision when there is none.

| Error | Status | Condition |
| --- | --- | --- |
| `DNS_REVISION_NOT_FOUND` | 404 | The cluster has no such revision, or its binding settings cannot be restored |
| `DNS_PROVIDER_NOT_FOUND` | 404 | The revision's provider account no longer exists |
| `NODE_GROUP_NOT_FOUND`, `DNS_ZONE_MISMATCH`, `DNS_LINE_UNSUPPORTED`, `DNS_POLICY_INVALID`, `DNS_BINDING_CONFLICT` | see [`dns.saveBinding`](#dnssavebinding) | The restored settings are no longer valid |

### `dns.forcePublishBinding`

`POST /clusters/{clusterId}/dns/force-publish` · write

Publishes a new revision from the cluster's current binding without the mass removal protection (reason `force`).

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | yes | — | Cluster ID |
| `revision` | body | integer | yes | ≥1 | The held-back revision (`status` `blocked`) |

Response: the new [DNS revision](#dns-revision-object); the target revision when the records equal it.

| Error | Status | Condition |
| --- | --- | --- |
| `DNS_NOT_BLOCKED` | 409 | The cluster has no such revision, or it is not `blocked` |

### `dns.protection`

`GET /dns/protection` · read

No parameters.

Response: `{ massRemovalRatio }` (number). `0.5` when never saved.

### `dns.setProtection`

`PUT /dns/protection` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `massRemovalRatio` | body | number | yes | 0.05–1 | Largest share of address records one publication may remove, for every cluster |

Response: `{ massRemovalRatio }`.

### `dns.reconcile`

`POST /dns/reconcile` · write

Recomputes and writes records. The body may be omitted.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | body | uuid | no | — | Reconcile this cluster only |

- With `clusterId`: reconciles that cluster and returns its error. While a run of that cluster is in progress, waits up to 30 seconds and then runs again.
- Without `clusterId`: reconciles every `auto` binding and every binding that still owns records, at most 4 at a time; a cluster's failure is recorded only in its revision's `lastError` and returns no error.
- `manual` bindings are never written to a provider.

Response: `{ ok: true }`.

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |
| `DNS_RECONCILE_BUSY` | 409 | The cluster's run is still in progress after 30 seconds |
| `DNS_BINDING_CONFLICT` | 409 | Another cluster manages the same name; `data.name` |
| `DNS_RECORD_CONFLICT` | 409 | A name to be written holds a record this cluster does not manage; `data.name` |
| `DNS_PROVIDER_AUTH_FAILED` | 400 | The provider rejects the credentials |
| `DNS_PROVIDER_ZONE_NOT_FOUND` | 400 | The provider has no such zone |
| `DNS_ADDRESS_REFUSED` | 400 | A self-hosted endpoint's address is outside the outbound policy |
| `DNS_ZONES_UNSUPPORTED` | 400 | The provider does not support the operation |
| `DNS_PROVIDER_RATE_LIMITED` | 429 | The provider rate-limits |
| `DNS_PROVIDER_UNREACHABLE` | 502 | The provider cannot be reached |
| `DNS_PROVIDER_FAILED` | 502 | Any other failed provider request |

## Regional probes

- A probe belongs to a region and measures the nodes' scheduling addresses from there; nodes can also probe (`nodes.setProbe`). Probe settings are `settings.probes` / `settings.setProbes`.
- Audit actions: `probe.token_create`, `probe.update`, `probe.delete`.
- Behaviour: [Regional probes and scheduling: regional probes](../../guide/scheduling.en.md#regional-probes).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`probes.list`](#probeslist) | `GET /probes` | read |
| [`probes.createToken`](#probescreatetoken) | `POST /probe-tokens` | write |
| [`probes.update`](#probesupdate) | `PATCH /probes/{id}` | write |
| [`probes.delete`](#probesdelete) | `DELETE /probes/{id}` | write |
| [`probes.results`](#probesresults) | `GET /probe-results` | read |

### `probes.list`

`GET /probes` · read

No parameters.

Response: [Probe](#probe-object)[], sorted by creation time.

### `probes.createToken`

`POST /probe-tokens` · write · `Idempotency-Key` not accepted

Creates a one-time token that enrolls one probe in a region.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | body | string | yes | 1–64 characters after trimming | Probe name |
| `regionId` | body | uuid | yes | — | Region ID |
| `ttlMinutes` | body | integer | no | 5–10080, default `60` | Token lifetime (minutes) |

Response:

| Field | Type | Description |
| --- | --- | --- |
| `tokenId` | uuid | Token ID |
| `token` | string | Token starting with `ewp_`, returned once; the console keeps only its SHA-256 |
| `expiresAt` | datetime | Token expiry |
| `serverUrl` | string | Node channel URL (`EDGEWEIR_SERVER`) |
| `caSha256` | string | SHA-256 of the node CA certificate (`EDGEWEIR_CA_SHA256`) |
| `command` | string | Command that starts the probe: `export EDGEWEIR_TOKEN=…` and `docker run` (the node image in `probe` mode) |

| Error | Status | Condition |
| --- | --- | --- |
| `REGION_NOT_FOUND` | 404 | The region does not exist |

### `probes.update`

`PATCH /probes/{id}` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Probe ID |
| `name` | body | string | no | 1–64 characters after trimming; unchanged when omitted | Probe name |
| `enabled` | body | boolean | no | Unchanged when omitted | `false`: the node channel refuses its certificate (except for renewal), its results are ignored and its existing results deleted |

Response: [Probe](#probe-object).

| Error | Status | Condition |
| --- | --- | --- |
| `PROBE_NOT_FOUND` | 404 | The probe does not exist |

### `probes.delete`

`DELETE /probes/{id}` · write

Deletes the probe and its results and revokes its current and previous certificates.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Probe ID |

Response: `{ ok: true }`.

| Error | Status | Condition |
| --- | --- | --- |
| `PROBE_NOT_FOUND` | 404 | The probe does not exist |

### `probes.results`

`GET /probe-results` · read

The latest result per prober, node, address and port. Results are kept for 1 hour.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `probeId` | query | uuid | no | — | Only this prober's results: a probe ID, or the ID of a node that also probes |
| `nodeId` | query | uuid | no | — | Only measurements of this node |

Response: [Probe result](#probe-result-object)[]: the newest at most 5000, sorted by node name, address, port and prober name.

| Error | Status | Condition |
| --- | --- | --- |
| `PROBE_NOT_FOUND` | 404 | `probeId` is neither a probe nor a node |
| `NODE_NOT_FOUND` | 404 | No node with `nodeId` |

## External probe sources

- Behavior: [External probe sources](../../guide/scheduling.en.md#external-probe-sources).

| Procedure | Method and path | Access |
| --- | --- | --- |
| `probeSources.list` | `GET /probe-sources` | read |
| `probeSources.create` | `POST /probe-sources` | write |
| `probeSources.update` | `PATCH /probe-sources/{id}` | write |
| `probeSources.delete` | `DELETE /probe-sources/{id}` | write |
| `probeSources.rotateWebhookSecret` | `POST /probe-sources/{id}/webhook-secret` | write |
| `probeSources.check` | `POST /probe-sources/check` | write |
| `probeSources.monitors` | `GET /probe-sources/{id}/monitors` | read |
| `probeSources.mappings` | `GET /probe-sources/{id}/mappings` | read |
| `probeSources.setMappings` | `PUT /probe-sources/{id}/mappings` | write |
| `probeSources.results` | `GET /probe-sources/{id}/results` | read |
| `probeSources.modes` | `GET /probe-modes` | read |
| `probeSources.setClusterMode` | `PUT /clusters/{clusterId}/probe-mode` | write |

`GET /api/v1/openapi.json` has the request and response fields.

## Scheduling rules

- A rule belongs to a cluster and applies a DNS action to nodes based on conditions on node and probe metrics: `remove_node` (the node leaves the rule's line, or every line), `backup_group` (the rule's line answers with its backup node groups), `backup_ip` (the node answers with its next scheduling address level).
- When an action starts or ends, a DNS revision is published (reason `scheduling`, `reasonParams.event` `activated` / `recovered`), audited as `scheduling.activate` / `scheduling.recover` (actor: the system).
- Audit actions: `scheduling.rule_create`, `scheduling.rule_update`, `scheduling.rule_delete`.
- Behaviour: [Regional probes and scheduling: scheduling rules](../../guide/scheduling.en.md#scheduling-rules), [actions](../../guide/scheduling.en.md#actions) and [states and timing](../../guide/scheduling.en.md#states-and-timing).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`scheduling.list`](#schedulinglist) | `GET /scheduling/rules` | read |
| [`scheduling.create`](#schedulingcreate) | `POST /scheduling/rules` | write |
| [`scheduling.update`](#schedulingupdate) | `PATCH /scheduling/rules/{id}` | write |
| [`scheduling.delete`](#schedulingdelete) | `DELETE /scheduling/rules/{id}` | write |
| [`scheduling.preview`](#schedulingpreview) | `GET /clusters/{clusterId}/scheduling/preview` | read |

### `scheduling.list`

`GET /scheduling/rules` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | query | uuid | no | — | Only this cluster's rules |

Response: [Scheduling rule](#scheduling-rule-object)[], sorted by creation time.

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | No cluster with `clusterId` |

### `scheduling.create`

`POST /scheduling/rules` · write · `201`

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | body | uuid | yes | — | Cluster ID |
| `lineName` | body | string | no | A line name of the cluster's DNS binding, or `null`, default `null`; required when `action` is `backup_group` | Line the rule applies to; `null` for every line |
| `name` | body | string | yes | 1–100 characters after trimming | Rule name |
| `enabled` | body | boolean | no | Default `true` | Enabled |
| `match` | body | enum | no | `all` / `any`, default `all` | `all`: every condition holds; `any`: one condition holds |
| `conditions` | body | `array<object>` | yes | 1–8 [scheduling conditions](#scheduling-condition-object) | Conditions |
| `action` | body | enum | yes | `remove_node` / `backup_group` / `backup_ip` | Action |
| `holdSeconds` | body | integer | no | 0–86400, default `300` | Minimum seconds the action stays |
| `recoverSeconds` | body | integer | no | 0–86400, default `300` | Seconds the conditions must stay clear before the action recovers |

Response: [Scheduling rule](#scheduling-rule-object).

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |
| `SCHEDULING_RULE_INVALID` | 400 | `backup_group` without `lineName`, or `lineName` is not in the cluster's DNS binding |
| `REGION_NOT_FOUND` | 404 | No region with a condition's `regionId` |

### `scheduling.update`

`PATCH /scheduling/rules/{id}` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Rule ID |
| `lineName` | body | string | no | As in `scheduling.create`; unchanged when omitted | Line name, or `null` |
| `name` | body | string | no | As in `scheduling.create`; unchanged when omitted | Rule name |
| `enabled` | body | boolean | no | Unchanged when omitted | Enabled |
| `match` | body | enum | no | `all` / `any`; unchanged when omitted | How conditions combine |
| `conditions` | body | `array<object>` | no | 1–8 [scheduling conditions](#scheduling-condition-object), replaced as a whole; unchanged when omitted | Conditions |
| `action` | body | enum | no | As in `scheduling.create`; unchanged when omitted | Action |
| `holdSeconds` | body | integer | no | 0–86400; unchanged when omitted | Minimum seconds the action stays |
| `recoverSeconds` | body | integer | no | 0–86400; unchanged when omitted | Seconds the conditions stay clear before recovery |

- The cluster cannot be changed.
- Changing an enabled rule to `enabled: false`, or `lineName`, `match`, `action` or `conditions` to a different value, ends the rule's current actions (publishing DNS revisions where needed) and restarts its states; changing only `name`, `holdSeconds` or `recoverSeconds` does not.
- The line is checked only when `lineName` or `action` is given, regions only when `conditions` is given.

Response: [Scheduling rule](#scheduling-rule-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SCHEDULING_RULE_NOT_FOUND` | 404 | The rule does not exist |
| `SCHEDULING_RULE_INVALID` | 400 | After the change, `backup_group` without `lineName`, or `lineName` is not in the cluster's DNS binding |
| `REGION_NOT_FOUND` | 404 | No region with a condition's `regionId` |

### `scheduling.delete`

`DELETE /scheduling/rules/{id}` · write

Deletes the rule; its current actions end, with one DNS revision per affected node (reason `scheduling`, `event` `recovered`).

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Rule ID |

Response: `{ ok: true }`.

| Error | Status | Condition |
| --- | --- | --- |
| `SCHEDULING_RULE_NOT_FOUND` | 404 | The rule does not exist |

### `scheduling.preview`

`GET /clusters/{clusterId}/scheduling/preview` · read

Evaluates every rule of the cluster against every node under the current metrics; writes nothing. Behaviour: [preview](../../guide/scheduling.en.md#preview).

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | yes | — | Cluster ID |

Response: [Scheduling preview](#scheduling-preview-object).

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |

## Objects

### DNS provider catalog object

| Field | Type | Description |
| --- | --- | --- |
| `id` | enum | Provider ID, see [Providers and credential fields](#providers-and-credential-fields) |
| `name` | string | English name |
| `fields` | `array<object>` | Credential fields, see the table below |
| `capabilities.recordTypes` | `array<enum>` | Record types it writes: `A`, `AAAA`, `CNAME`, `TXT` |
| `capabilities.listZones` | boolean | Can list the account's zones (`dns.zones`) |
| `capabilities.lines` | `array<enum>` | Resolution lines the adapter writes, `default` first: a subset of `default`, `telecom`, `unicom`, `mobile`, `edu`, `overseas` |
| `capabilities.apex` | enum | How the apex can point at a host name: `cname` (CNAME flattening), `alias` (ALIAS record), or `null` (not at all) |
| `capabilities.endpoint` | enum | `fixed`: the provider's fixed endpoint; `custom`: the user enters the server address and the outbound address policy applies |

`fields[]`:

| Field | Type | Description |
| --- | --- | --- |
| `key` | string | Credential key (snake_case), the key in `credentials` |
| `type` | enum | `text` / `secret` / `select` / `textarea` / `url` |
| `secret` | boolean | Never displayed after saving; entered in a password field |
| `required` | boolean | Required |
| `placeholder` | string | Format example; may be absent |
| `pattern` | string | Anchored regular expression the value must match (JavaScript and RE2 compatible); may be absent |
| `maxLength` | number | Maximum length |
| `options` | `array<string>` | Allowed values of a `select` field; may be absent |
| `default` | string | Default value; may be absent |

### Providers and credential fields

Every provider writes `A`, `AAAA`, `CNAME` and `TXT` records. "All lines" means `default`, `telecom`, `unicom`, `mobile`, `edu`, `overseas`; the other providers have `default` only.

| ID | Name | Lists zones | Resolution lines | Apex | Endpoint |
| --- | --- | --- | --- | --- | --- |
| `cloudflare` | Cloudflare | yes | `default` | `cname` | `fixed` |
| `alidns` | Alibaba Cloud DNS | yes | all lines | `null` | `fixed` |
| `huaweicloud` | Huawei Cloud DNS | yes | all lines | `null` | `fixed` |
| `dnspod` | DNSPod (token API) | yes | all lines | `null` | `fixed` |
| `tencentcloud` | Tencent Cloud DNSPod (API 3.0) | yes | all lines | `null` | `fixed` |
| `volcengine` | Volcengine DNS | yes | `default` | `null` | `fixed` |
| `baiducloud` | Baidu AI Cloud DNS | yes | `default` | `null` | `fixed` |
| `westcn` | West.cn | yes | `default` | `null` | `fixed` |
| `dnsla` | DNS.LA | yes | `default` | `null` | `fixed` |
| `route53` | Amazon Route 53 | yes | `default` | `null` | `fixed` |
| `googleclouddns` | Google Cloud DNS | yes | `default` | `alias` | `fixed` |
| `azure` | Azure DNS | yes | `default` | `null` | `fixed` |
| `digitalocean` | DigitalOcean | yes | `default` | `null` | `fixed` |
| `vultr` | Vultr | yes | `default` | `null` | `fixed` |
| `linode` | Akamai Cloud (Linode) | yes | `default` | `null` | `fixed` |
| `hetzner` | Hetzner Cloud DNS | yes | `default` | `null` | `fixed` |
| `ovh` | OVHcloud | yes | `default` | `null` | `fixed` |
| `gandi` | Gandi LiveDNS | yes | `default` | `alias` | `fixed` |
| `godaddy` | GoDaddy | yes | `default` | `null` | `fixed` |
| `porkbun` | Porkbun | yes | `default` | `alias` | `fixed` |
| `namesilo` | NameSilo | yes | `default` | `null` | `fixed` |
| `gcore` | Gcore | yes | `default` | `cname` | `fixed` |
| `bunny` | Bunny DNS | yes | `default` | `cname` | `fixed` |
| `desec` | deSEC | yes | `default` | `null` | `fixed` |
| `powerdns` | PowerDNS | yes | `default` | `null` | `custom` |
| `rfc2136` | RFC 2136 (TSIG) | no | `default` | `null` | `custom` |
| `webhook` | Custom HTTP | yes | `default` | `null` | `custom` |
| `test` | Local test fixture | yes | all lines | `null` | `fixed` |

`test` is available only when `EDGEWEIR_DNS_TEST_ENDPOINT` is set.

Credential fields (`secret` and `textarea` fields are never displayed after saving):

| Provider | Field | Type | Required | Max length | Format and default |
| --- | --- | --- | --- | --- | --- |
| `cloudflare` | `api_token` | secret | yes | 256 | 20–256 letters, digits, `_`, `.`, `-` |
| `cloudflare` | `zone_token` | secret | no | 256 | As `api_token` |
| `alidns` | `access_key_id` | text | yes | 128 | 1–128 letters, digits, `.` |
| `alidns` | `access_key_secret` | secret | yes | 256 | — |
| `alidns` | `region_id` | text | no | 32 | 1–32 lowercase letters, digits, `-`; example `cn-hangzhou` |
| `alidns` | `security_token` | secret | no | 4096 | — |
| `huaweicloud` | `access_key_id` | text | yes | 128 | 1–128 letters, digits |
| `huaweicloud` | `secret_access_key` | secret | yes | 256 | — |
| `huaweicloud` | `region_id` | text | no | 32 | 1–32 lowercase letters, digits, `-`; example `cn-north-4` |
| `dnspod` | `auth_token` | secret | yes | 149 | `<ID>,<Token>`: 1–20 digits, a comma, 8–128 letters and digits |
| `tencentcloud` | `secret_id` | text | yes | 128 | 1–128 letters, digits |
| `tencentcloud` | `secret_key` | secret | yes | 256 | — |
| `tencentcloud` | `site` | select | no | 4 | `cn` / `intl`, default `cn` |
| `volcengine` | `access_key_id` | text | yes | 128 | 16–128 letters, digits |
| `volcengine` | `secret_access_key` | secret | yes | 256 | — |
| `baiducloud` | `access_key_id` | text | yes | 128 | 16–128 letters, digits |
| `baiducloud` | `secret_access_key` | secret | yes | 256 | — |
| `westcn` | `username` | text | yes | 64 | — |
| `westcn` | `api_password` | secret | yes | 256 | — |
| `dnsla` | `api_id` | text | yes | 128 | 1–128 printable ASCII characters except space and `:` |
| `dnsla` | `api_secret` | secret | yes | 256 | — |
| `route53` | `access_key_id` | text | yes | 128 | 16–128 letters, digits, `_` |
| `route53` | `secret_access_key` | secret | yes | 128 | — |
| `route53` | `session_token` | secret | no | 8192 | — |
| `route53` | `hosted_zone_id` | text | no | 44 | 1–32 uppercase letters and digits, optionally prefixed with `/hostedzone/` |
| `route53` | `partition` | select | no | 10 | `aws` / `aws-cn` / `aws-us-gov`, default `aws` |
| `googleclouddns` | `service_account_json` | textarea | yes | 16384 | Service account key JSON |
| `googleclouddns` | `project_id` | text | no | 100 | 6–30 characters, starting with a lowercase letter, lowercase letters, digits, `-`, not ending with `-`; optionally prefixed with `<domain>:` |
| `googleclouddns` | `managed_zone` | text | no | 63 | Managed zone name (starting with a lowercase letter, 1–63 lowercase letters, digits, `-`) or a numeric ID of 1–20 digits |
| `azure` | `tenant_id` | text | yes | 253 | GUID or domain name |
| `azure` | `client_id` | text | yes | 36 | GUID |
| `azure` | `client_secret` | secret | yes | 1024 | — |
| `azure` | `subscription_id` | text | yes | 36 | GUID |
| `azure` | `resource_group` | text | yes | 90 | 1–90 letters, digits, `_`, `(`, `)`, `.`, `-`, not ending with `.` |
| `digitalocean` | `api_token` | secret | yes | 128 | 64 lowercase hexadecimal digits, optionally prefixed with `dop_v1_` |
| `vultr` | `api_key` | secret | yes | 64 | — |
| `linode` | `api_token` | secret | yes | 128 | — |
| `hetzner` | `api_token` | secret | yes | 128 | — |
| `ovh` | `endpoint` | select | yes | 6 | `ovh-eu` / `ovh-ca` / `ovh-us`, default `ovh-eu` |
| `ovh` | `application_key` | text | yes | 128 | 8–128 letters, digits |
| `ovh` | `application_secret` | secret | yes | 128 | 8–128 letters, digits |
| `ovh` | `consumer_key` | secret | yes | 128 | 8–128 letters, digits |
| `gandi` | `bearer_token` | secret | yes | 512 | 16–512 letters, digits, `_`, `.`, `-` |
| `godaddy` | `api_token` | secret | yes | 4096 | `key:secret` (each part 8–128 letters, digits, `_`), or at least 16 letters, digits and `_.~+/=-` |
| `porkbun` | `api_key` | secret | yes | 260 | `pk1_` followed by 8–256 letters, digits, `_` |
| `porkbun` | `api_secret_key` | secret | yes | 260 | `sk1_` followed by 8–256 letters, digits, `_` |
| `namesilo` | `api_token` | secret | yes | 128 | 8–128 letters, digits |
| `gcore` | `api_key` | secret | yes | 4096 | `<digits>$<letters, digits and ._~+/=->` |
| `bunny` | `access_key` | secret | yes | 128 | 16–128 letters, digits, `-` |
| `desec` | `token` | secret | yes | 128 | 16–128 letters, digits, `_`, `-` |
| `powerdns` | `server_url` | url | yes | 256 | `http://` or `https://` plus a host (port allowed), optional trailing `/`, no path, query, `@` or fragment |
| `powerdns` | `api_key` | secret | yes | 256 | — |
| `powerdns` | `server_id` | text | no | 64 | 1–64 letters, digits, `.`, `_`, `-`, default `localhost` |
| `rfc2136` | `server` | text | yes | 261 | Host or `host:port`: 1–261 letters, digits and `._:[]-` |
| `rfc2136` | `tsig_key_name` | text | yes | 253 | 1–253 letters, digits, `.`, `_`, `-` |
| `rfc2136` | `tsig_algorithm` | select | yes | 11 | `hmac-sha256` / `hmac-sha512` / `hmac-sha384` / `hmac-sha224` / `hmac-sha1`, default `hmac-sha256` |
| `rfc2136` | `tsig_secret` | secret | yes | 512 | Base64 |
| `webhook` | `url` | url | yes | 512 | `http://` or `https://` URL without whitespace, `@` or `#` |
| `webhook` | `secret` | secret | yes | 256 | At least 16 characters |
| `test` | `api_token` | secret | yes | 1024 | — |

### DNS provider account object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Account ID |
| `name` | string | Account name |
| `provider` | enum | Provider ID |
| `zone` | string | Zone |

### DNS binding object

| Field | Type | Description |
| --- | --- | --- |
| `clusterId` | uuid | Cluster ID |
| `mode` | enum | `off` / `manual` / `auto` |
| `providerId` | uuid | Provider account ID, or `null` |
| `zone` | string | The account's zone; empty string without an account |
| `domain` | string | Parent name of the cluster's records |
| `ttl` | number | TTL (seconds) |
| `lines` | [DNS line](#dns-line-object)[] | Lines; fields missing from lines saved earlier are returned with their defaults |
| `lineAliases` | boolean | Line aliases are kept for every site |
| `allLabel` | string | Name of the record with every line's addresses: `all`, or `all-<n>` for shared domains migrated from the global DNS configuration |
| `updatedAt` | datetime | Last save; `1970-01-01T00:00:00.000Z` when never saved |

### DNS line object

`binding.lines[]` of `dns.saveBinding` and `lines[]` of the [DNS binding](#dns-binding-object).

| Field | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- |
| `name` | string | yes | 1–32 lowercase letters, digits, `-`, starting and ending with a letter or digit, not `all` | Line name; its record is `<name>.<domain>` |
| `nodeGroupId` | uuid | yes | A node group of this cluster | The line's node group |
| `overrides` | `array<object>` | no | At most 1000 `{ nodeId, addresses }`, default `[]`; `nodeId` a node of that node group, unique; `addresses` 1–8 IP addresses (normalized), not loopback, link-local, multicast, documentation or other special-purpose addresses (private `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7` excepted) | Addresses the node uses on this line |
| `resolutionLine` | enum | no | `default` / `telecom` / `unicom` / `mobile` / `edu` / `overseas`, default `default` | Resolution line on which the all-lines record answers with this line's addresses |
| `backupNodeGroupIds` | `array<uuid>` | no | At most 4 node groups of this cluster, unique, not `nodeGroupId`, default `[]` | Backup node groups |
| `minHealthyIps` | integer | no | 1–64, default `1` | While the line's node group has fewer healthy addresses, the first backup group with at least this many answers |

Behaviour: [DNS steering: records per resolution line](../../guide/dns.en.md#records-per-resolution-line) and [backup node groups](../../guide/dns.en.md#backup-node-groups).

### DNS record object

| Field | Type | Description |
| --- | --- | --- |
| `name` | string | Record name: relative to the zone (`@` for the apex); absolute in `dns.exportBinding` |
| `type` | enum | `A` / `AAAA` / `CNAME` / `TXT` |
| `data` | string | Record value |
| `ttl` | number | TTL (seconds) |
| `line` | enum | Resolution line: `telecom` / `unicom` / `mobile` / `edu` / `overseas`; absent on records of the default line |

### DNS revision object

| Field | Type | Description |
| --- | --- | --- |
| `revision` | number | Revision number |
| `status` | enum | `pending` (to be written) / `applied` (written; a `manual` revision is `applied` once saved) / `failed` / `superseded` (replaced by a newer revision) / `blocked` (held back by the mass removal protection) |
| `reason` | string | Publication reason code, see the table below; unknown codes are shown as they are |
| `reasonParams` | object | Parameters of the reason, values string or number; `{}` without parameters |
| `recordCount` | number | Number of records |
| `createdAt` | datetime | Creation time |
| `appliedAt` | datetime | When writing completed, or `null` |
| `lastError` | string | Code of the latest failure, empty string without one; for example `dns_reconcile_failed`, `dns_auth_failed`, `dns_zone_not_found`, `dns_provider_unreachable`, `dns_rate_limited`, `dns_record_conflict`, `dns_binding_conflict`, `dns_zone_mismatch`, `dns_mass_removal_blocked`, `certd_failed`, `certd_timeout` |
| `lastErrorParams` | object | Parameters of the error code (string): `name` for `dns_record_conflict` and `dns_binding_conflict` |

| Reason | Parameters | Published when |
| --- | --- | --- |
| `manual` | — | A binding is saved (`dns.saveBinding`), or a node's scheduling addresses change (`nodes.setAddresses`) |
| `health` | — | Node health changes during reconciliation, or the probes' reachability verdict on a scheduling address changes |
| `rollback` | — | `dns.rollbackBinding` |
| `force` | — | `dns.forcePublishBinding` |
| `scheduling` | `rule`, `node`, `ruleId`, `nodeId`, `action` (`remove_node` / `backup_group` / `backup_ip`), `event` (`activated` / `recovered`) | A scheduling rule's action starts or ends |
| `cname` | `name` | A site's or layer-4 application's CNAME prefix changes |
| `cname_expired` | — | Replaced CNAME prefixes stop resolving after their 24 hours |

### Probe object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Probe ID |
| `name` | string | Name |
| `regionId` | uuid | Region ID |
| `regionName` | string | Region name |
| `regionCode` | string | Region code |
| `enabled` | boolean | Enabled |
| `online` | boolean | Asked for targets or reported results within `max(3 × probe interval, 30 s)` |
| `lastSeenAt` | datetime | Last connection, or `null` |
| `enrolledAt` | datetime | Enrollment time, or `null` |
| `hostname` | string | Host name |
| `agentVersion` | string | Probe program version |
| `os` | string | Operating system |
| `arch` | string | CPU architecture |
| `certNotAfter` | datetime | Certificate expiry, or `null` |
| `targets` | integer | Targets the probe gets now: every scheduling address of every enabled node × each listener port of its cluster |
| `lastRound` | object | The latest round, `null` without results: `checkedAt` (datetime), `results` (integer, targets), `failed` (integer, targets that lost every attempt), `lossPercent` (number, lost attempts / sent attempts in percent, one decimal), `avgRttMs` (number, mean of the median round-trip times of the answering targets; `null` when none answered) |
| `channel` | [Node channel status](#node-channel-status-object) | The probe's node channel status; `null` until the probe connects to a console that records it |
| `createdAt` | datetime | Creation time |

### Node channel status object

| Field | Type | Description |
| --- | --- | --- |
| `url` | string | Node channel URL in use, or `null` |
| `serverName` | string | TLS server name of that URL |
| `fallbackUrl` | string | The URL before the last switch, tried while `url` fails; or `null` |
| `fallbackServerName` | string | TLS server name of the fallback URL |
| `onFallback` | boolean | Running on the fallback because `url` failed |
| `source` | enum | How `url` was set: `enroll` (enrollment) / `console` (the console's address) / `command` (`edgeweir-node set-server`), or `null` |
| `switchedAt` | datetime | Last switch, or `null` |
| `error` | object | The last failed check of an address, or `null`: `code`, `message`, `url`, `serverName`, `at` (datetime) |
| `observedServerName` | string | TLS server name of the latest connection; empty string when none was sent (an IP address) |
| `observedWebSocket` | boolean | The latest connection came through the WebSocket entry |
| `observedAt` | datetime | Latest connection |

### Probe result object

| Field | Type | Description |
| --- | --- | --- |
| `proberKind` | enum | `probe` (a probe) / `node` (a node that also probes) |
| `proberId` | uuid | Prober ID |
| `proberName` | string | Prober name |
| `regionId` | uuid | The prober's region ID, or `null` |
| `regionName` | string | Region name, or `null` |
| `nodeId` | uuid | ID of the measured node |
| `nodeName` | string | Node name |
| `address` | string | Scheduling address |
| `port` | integer | Port |
| `method` | enum | `tcp` / `http` / `https` |
| `sent` | integer | Attempts sent |
| `lost` | integer | Attempts lost |
| `lossPercent` | number | Share lost (percent, one decimal) |
| `rttMs` | integer | Median round-trip time of the answered attempts; `0` when all were lost |
| `error` | string | Code of the last failure: `timeout`, `refused`, `reset`, `tls`, `status`, `unreachable` |
| `checkedAt` | datetime | Measurement time |

### Scheduling condition object

| Field | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- |
| `metric` | enum | yes | `cpu_percent` / `load1` / `memory_percent` / `egress_mbps` / `connections` / `probe_loss_percent` / `probe_latency_ms` | Metric; the last two are probe metrics |
| `aggregate` | enum | no | `avg` / `max` / `min`, default `avg` | How a probe metric combines over the probers; a node metric is the node's own value |
| `comparator` | enum | yes | `gt` / `ge` / `lt` / `le` | Comparison |
| `threshold` | number | yes | 0–10¹² | Threshold |
| `durationSeconds` | integer | no | 0–3600, default `0` | Seconds the comparison must hold before the condition counts |
| `regionId` | uuid | no | Default `null`; probe metrics only, otherwise 400 `BAD_REQUEST` | Count only this region's probers |

### Scheduling rule object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Rule ID |
| `clusterId` | uuid | Cluster ID |
| `lineName` | string | Line name, or `null` (every line) |
| `name` | string | Rule name |
| `enabled` | boolean | Enabled |
| `match` | enum | `all` / `any` |
| `conditions` | [Scheduling condition](#scheduling-condition-object)[] | Conditions, with defaults filled in |
| `action` | enum | `remove_node` / `backup_group` / `backup_ip` |
| `holdSeconds` | integer | Minimum seconds the action stays |
| `recoverSeconds` | integer | Seconds the conditions stay clear before recovery |
| `activeNodes` | `array<object>` | Nodes the action applies to now (active or recovering) `{ nodeId, nodeName, since }`, sorted by node name; `since` a datetime |
| `createdAt` | datetime | Creation time |
| `updatedAt` | datetime | Last change |

### Scheduling preview object

| Field | Type | Description |
| --- | --- | --- |
| `clusterId` | uuid | Cluster ID |
| `evaluatedAt` | datetime | Evaluation time |
| `rules` | `array<object>` | Per rule: `ruleId`, `ruleName`, `enabled`, `lineName` (or `null`), `match`, `action`, `nodes` |
| `rules[].nodes` | `array<object>` | Each node the rule looks at, fields in the table below |

`rules[].nodes[]`:

| Field | Type | Description |
| --- | --- | --- |
| `nodeId` | uuid | Node ID |
| `nodeName` | string | Node name |
| `state` | enum | `idle` (conditions clear) / `pending` (met, but not yet for their durations) / `active` / `recovering` (clear, waiting to recover) |
| `conditions` | `array<object>` | Per condition: the fields of a [scheduling condition](#scheduling-condition-object) plus `value` (number, the current value; `null` without fresh metrics or probe results), `holds` (boolean, the comparison holds now), `heldSeconds` (integer, how long it has held as of the last evaluation), `satisfied` (boolean, it has held for at least `durationSeconds`) |
| `matches` | boolean | The conditions are met now under `match`, with their durations |
| `inEffect` | boolean | The action applies to the node now (`active` or `recovering`) |
| `wouldActivate` | boolean | The next evaluation starts the action |
| `wouldRecover` | boolean | The next evaluation ends the action |
| `activeSince` | datetime | When the action started, or `null` |
| `recoveringSince` | datetime | When recovery started, or `null` |
| `recoversAt` | datetime | Earliest end of the action if the conditions stay clear, or `null` |
