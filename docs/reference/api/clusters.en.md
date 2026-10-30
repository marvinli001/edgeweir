# API: Clusters and nodes

Procedures for clusters, revisions and canary, network settings, enrollment tokens, node groups, nodes, logs, regions, upgrades, port pools and L4 apps.

Access levels, authentication, idempotency keys and the error format: [API overview](../api.en.md).

## Clusters

- Creating a cluster also creates its default node group `default` and publishes revision 1 (reason `cluster_created`).
- Audit: `cluster.create`, `cluster.update`, `cluster.delete`.
- Behaviour: [Clusters and nodes](../../guide/clusters.en.md#clusters).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`clusters.list`](#clusterslist) | `GET /clusters` | read; service account `clusters:read` |
| [`clusters.get`](#clustersget) | `GET /clusters/{id}` | read; service account `clusters:read` |
| [`clusters.create`](#clusterscreate) | `POST /clusters` | write |
| [`clusters.update`](#clustersupdate) | `PATCH /clusters/{id}` | write |
| [`clusters.delete`](#clustersdelete) | `DELETE /clusters/{id}` | write |

### `clusters.list`

`GET /clusters` · read · service account `clusters:read`

No parameters.

Response: [Cluster](#cluster-object)`[]`, oldest first.

### `clusters.get`

`GET /clusters/{id}` · read · service account `clusters:read`

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Cluster ID |

Response: [Cluster](#cluster-object).

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |

### `clusters.create`

`POST /clusters` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | body | string | yes | 1–64 characters after trimming; lowercase letters, digits and `-`, starting with a lowercase letter or digit | Cluster name, unique |
| `description` | body | string | no | At most 500 characters after trimming, default `""` | Description |

Response: [Cluster](#cluster-object).

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NAME_TAKEN` | 409 | Another cluster has the name; `data.name` |

### `clusters.update`

`PATCH /clusters/{id}` · write

Publishes no revision.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Cluster ID |
| `name` | body | string | no | As in `clusters.create`; unchanged when omitted | Cluster name |
| `description` | body | string | no | At most 500 characters after trimming; unchanged when omitted | Description |

Response: [Cluster](#cluster-object).

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |
| `CLUSTER_NAME_TAKEN` | 409 | Another cluster has the name; `data.name` |

### `clusters.delete`

`DELETE /clusters/{id}` · write

Only a cluster without nodes and sites can be deleted. The cluster's platform alerts end with it.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Cluster ID |

Response: `{ ok: true }`.

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |
| `CLUSTER_NOT_EMPTY` | 409 | The cluster still has nodes (disabled ones included) or sites; `data.nodes`, `data.sites` are the counts |
| `DNS_BINDING_IN_USE` | 409 | The cluster's DNS binding is in automatic mode or still holds records at the provider |

## Revisions and canary

- Revision reason codes: `rollback` (`reasonParams.revision` is the rollback target), `rollout_rollback` (`reasonParams.revision` is the candidate).
- Audit: `cluster.rollback`, `cluster.rollout_policy_update`, `cluster.rollout_promote`, `cluster.rollout_abort`.
- Behaviour: [Revisions](../../guide/clusters.en.md#revisions) and [Configuration canary](../../guide/clusters.en.md#configuration-canary).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`clusters.revisions`](#clustersrevisions) | `GET /clusters/{id}/revisions` | read |
| [`clusters.rollback`](#clustersrollback) | `POST /clusters/{id}/rollback` | write |
| [`clusters.rollbackPreview`](#clustersrollbackpreview) | `GET /clusters/{id}/rollback-preview` | read |
| [`clusters.rollout`](#clustersrollout) | `GET /clusters/{id}/rollout` | read |
| [`clusters.setRolloutPolicy`](#clusterssetrolloutpolicy) | `PUT /clusters/{id}/rollout-policy` | write |
| [`clusters.promoteRollout`](#clusterspromoterollout) | `POST /clusters/{id}/rollout/promote` | write |
| [`clusters.abortRollout`](#clustersabortrollout) | `POST /clusters/{id}/rollout/abort` | write |

### `clusters.revisions`

`GET /clusters/{id}/revisions` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Cluster ID |

Response: [Revision](#revision-object)`[]`, newest first, at most 100.

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |

### `clusters.rollback`

`POST /clusters/{id}/rollback` · write

Publishes the content of the chosen revision as the cluster's next revision. The origin address allow list, the platform error pages, the offline hosts and the IP lists are taken as they are now, not as the old revision had them. When the content equals the latest revision, no revision is created and the latest one is returned. With the configuration canary on, the new revision goes to every node at once; the rollout state becomes `promoted` with outcome `manual_rollback`.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Cluster ID |
| `revision` | body | integer | yes | ≥1 | Revision to roll back to |

Response: [Revision](#revision-object).

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |
| `REVISION_NOT_FOUND` | 404 | The cluster has no such revision (including revisions pruned beyond the retention) |
| `ROLLBACK_RESOURCE_UNAVAILABLE` | 409 | The target revision references a deleted site, domain or IP list, or an unavailable or expired certificate |
| `CLUSTER_SITE_LIMIT` | 409 | The published site count would exceed the cluster's limit; `data.limit` |

### `clusters.rollbackPreview`

`GET /clusters/{id}/rollback-preview` · read

Builds the content as the rollback would and compares it with the latest revision. Writes nothing.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Cluster ID |
| `revision` | query | integer | yes | ≥1 | Revision to roll back to |

Response: `{ revision, currentRevision, unchanged, sites: { added, changed, removed } }`. `currentRevision` is the cluster's latest revision number, `null` without revisions; `unchanged` is `true` when the rollback content equals the latest revision and the rollback would publish nothing new; the three `sites` arrays are `[{ id, name }]`, the sites added, changed and removed (compared by name).

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |
| `REVISION_NOT_FOUND` | 404 | The cluster has no such revision |
| `ROLLBACK_RESOURCE_UNAVAILABLE` | 409 | As in `clusters.rollback` |

### `clusters.rollout`

`GET /clusters/{id}/rollout` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Cluster ID |

Response: [Rollout](#rollout-object). Before a policy was ever saved, `policy` holds the defaults: `enabled: false`, `windowSeconds: 300`, `autoPromote: true`, `errorRatioMultiplier: 2`, `errorRatioFloor: 0.05`, `minRequests: 100`.

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |

### `clusters.setRolloutPolicy`

`PUT /clusters/{id}/rollout-policy` · write

Replaces the policy. Turning it on pins the current latest revision as the stable revision; turning it off during a rollout gives the candidate to every node (outcome `policy_disabled`).

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Cluster ID |
| `enabled` | body | boolean | yes | — | Configuration canary on |
| `windowSeconds` | body | integer | yes | 60–3600 | Observation window (seconds) |
| `autoPromote` | body | boolean | yes | — | Promote when the window passes; `false` waits for the operator |
| `errorRatioMultiplier` | body | number | yes | 1–100 | Roll back when the canary 5xx ratio exceeds `max(baseline × errorRatioMultiplier, errorRatioFloor)` |
| `errorRatioFloor` | body | number | yes | 0.001–1 | See above |
| `minRequests` | body | integer | yes | 1–1000000 | Requests the canary nodes must serve in the window before the ratio counts |
| `expectedUpdatedAt` | body | datetime | no | — | Optimistic concurrency: the `policyUpdatedAt` last read (`updatedAt` is accepted too) |

Response: [Rollout](#rollout-object).

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |
| `UPDATED_AT_MISMATCH` | 409 | `expectedUpdatedAt` is neither the current `policyUpdatedAt` nor `updatedAt`; `data.updatedAt` |

### `clusters.promoteRollout`

`POST /clusters/{id}/rollout/promote` · write

The candidate becomes the stable revision of every node now (outcome `manual_promote`).

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Cluster ID |

Response: [Rollout](#rollout-object).

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |
| `ROLLOUT_NOT_ACTIVE` | 409 | No canary rollout is running (policy off, state not `canary` / `awaiting_promotion`, or no candidate) |

### `clusters.abortRollout`

`POST /clusters/{id}/rollout/abort` · write

Publishes the stable content as a new revision (reason `rollout_rollback`), which becomes the stable revision of every node; the state becomes `rolled_back` with outcome `manual_abort`, and the platform alert `config_rollout_failed` is raised.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Cluster ID |

Response: [Rollout](#rollout-object).

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |
| `ROLLOUT_NOT_ACTIVE` | 409 | As in `clusters.promoteRollout` |

## Cluster network settings (listen ports, client IP, unknown hosts, connection limits, cache zone)

- The `set*` procedures replace the setting. A setting equal to the current one publishes nothing and writes no audit entry; otherwise a revision is published and audited.
- Revision reason codes and audit actions:

| Procedure | Reason code | Audit |
| --- | --- | --- |
| `clusters.setListenPorts` | `listen_ports_updated` | `cluster.listen_ports_update` |
| `clusters.setClientIp` | `client_ip_updated` | `cluster.client_ip_update` |
| `clusters.setUnknownHosts` | `unknown_hosts_updated` | `cluster.unknown_hosts_update` |
| `clusters.setConnectionLimits` | `connection_limits_updated` | `cluster.connection_limits_update` |
| `clusters.setCache` | `cluster_cache_updated` | `cluster.cache_update` |

- `nodesWithout` in responses (`[{ id, name }]`) lists the active nodes without the feature; they apply the new setting only after an upgrade, see [Node capabilities](../../guide/node-upgrades.en.md#node-capabilities).
- Behaviour: [The cluster's listener ports](../../guide/https.en.md#the-clusters-listener-ports), [Client IP](../../deploy/nodes.en.md#client-ip), [Unknown hosts and node IP access](../../guide/domains.en.md#unknown-hosts-and-node-ip-access), [Connection limits](../../guide/bans.en.md#connection-limits), [Cache zone](../../guide/origins-and-cache.en.md#cache-zone).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`clusters.listenPorts`](#clusterslistenports) | `GET /clusters/{clusterId}/listen-ports` | read |
| [`clusters.setListenPorts`](#clusterssetlistenports) | `PUT /clusters/{clusterId}/listen-ports` | write |
| [`clusters.clientIp`](#clustersclientip) | `GET /clusters/{clusterId}/client-ip` | read |
| [`clusters.setClientIp`](#clusterssetclientip) | `PUT /clusters/{clusterId}/client-ip` | write |
| [`clusters.unknownHosts`](#clustersunknownhosts) | `GET /clusters/{clusterId}/unknown-hosts` | read |
| [`clusters.setUnknownHosts`](#clusterssetunknownhosts) | `PUT /clusters/{clusterId}/unknown-hosts` | write |
| [`clusters.connectionLimits`](#clustersconnectionlimits) | `GET /clusters/{clusterId}/connection-limits` | read |
| [`clusters.setConnectionLimits`](#clusterssetconnectionlimits) | `PUT /clusters/{clusterId}/connection-limits` | write |
| [`clusters.setCache`](#clusterssetcache) | `PUT /clusters/{id}/cache` | write |

### `clusters.listenPorts`

`GET /clusters/{clusterId}/listen-ports` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | yes | — | Cluster ID |

Response: `{ clusterId, httpPorts, httpsPorts, nodesWithout }`. `httpPorts` and `httpsPorts` are the extra ports, ascending, without 80 and 443 (always listened on); `nodesWithout` lists active nodes without `edge-ports-v1`.

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |

### `clusters.setListenPorts`

`PUT /clusters/{clusterId}/listen-ports` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | yes | — | Cluster ID |
| `httpPorts` | body | `array<integer>` | yes | At most 16; 1–65535, not 80 or 443; saved deduplicated and ascending | Extra HTTP ports |
| `httpsPorts` | body | `array<integer>` | yes | As above | Extra HTTPS ports |

Response: as `clusters.listenPorts`.

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |
| `LISTEN_PORT_CONFLICT` | 400 | A port is in both `httpPorts` and `httpsPorts`; `data.port` |
| `LISTEN_PORT_IN_POOL` | 400 | A port is inside a port pool of the cluster (any protocol); `data.port`, `data.pools` (`from-to/protocol`, comma-separated) |
| `LISTEN_PORT_IN_USE` | 409 | A removed port is still used by a site of the cluster; `data.port`, `data.sites` (first 5 site names) |

### `clusters.clientIp`

`GET /clusters/{clusterId}/client-ip` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | yes | — | Cluster ID |

Response: `{ clusterId, settings: { mode, trustedCidrs, header, dropForwardedFor }, nodesWithout }`. Never set: `settings` is `direct`, `[]`, `""`, `false`; `nodesWithout` lists active nodes without `client-ip-v1`.

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |

### `clusters.setClientIp`

`PUT /clusters/{clusterId}/client-ip` · write

`trustedCidrs` and `header` are saved in `header` mode only; `dropForwardedFor` in `direct` mode only.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | yes | — | Cluster ID |
| `settings` | body | object | yes | — | Client address setting |
| `settings.mode` | body | enum | no | `direct` / `proxy_protocol` / `header`, default `direct` | `direct`: the TCP peer; `proxy_protocol`: the PROXY protocol header every TCP connection starts with (QUIC keeps the UDP peer); `header`: a header sent by peers inside the trusted ranges |
| `settings.trustedCidrs` | body | `array<string>` | no | At most 64 IP addresses or CIDRs, normalized (`10.1.2.3/8` is saved as `10.0.0.0/8`), deduplicated and sorted; IPv4-mapped IPv6 ranges refused; default `[]`; at least 1 in `header` mode | Trusted proxy ranges |
| `settings.header` | body | string | no | After trimming and lowercasing 1–64 of `[a-z0-9-]`; not starting with `x-edgeweir-`, not `connection`, `keep-alive`, `proxy-connection`, `transfer-encoding`, `upgrade`, `te`, `trailer`, `host`, `content-length`, `content-type`, `cookie`, `authorization`, `cdn-loop`, `x-request-id`; default `""`; required in `header` mode | Header carrying the client address, such as `x-forwarded-for`, `x-real-ip`, `cf-connecting-ip`, `true-client-ip` |
| `settings.dropForwardedFor` | body | boolean | no | Default `false`; `direct` mode only | Send the origins only the TCP peer as `X-Forwarded-For` |

Response: as `clusters.clientIp`.

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |

### `clusters.unknownHosts`

`GET /clusters/{clusterId}/unknown-hosts` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | yes | — | Cluster ID |

Response: `{ clusterId, settings, defaultSite, nodesWithout }`. `settings` has the fields of `settings` in `clusters.setUnknownHosts`; `defaultSite` is `{ id, name, enabled, certificate }` (`certificate`: the site has a certificate) or `null` without a default site; while the default site is disabled or has no certificate, nodes answer as with `page` (and abort unknown SNI); `nodesWithout` lists active nodes without `unknown-host-v1`.

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |

### `clusters.setUnknownHosts`

`PUT /clusters/{clusterId}/unknown-hosts` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | yes | — | Cluster ID |
| `settings` | body | object | yes | — | Unknown host settings |
| `settings.unknownHost` | body | enum | no | `page` / `close` / `site`, default `page` | A host no site serves: `page` the platform's unknown host page (404), `close` no response (444), `site` the default site |
| `settings.ipAccess` | body | enum | no | As above, default `page` | Requests by node IP or without a Host |
| `settings.defaultSiteId` | body | uuid | no | May be `null`, default `null`; required when `unknownHost` or `ipAccess` is `site`, an enabled site of this cluster; not saved when neither is `site` | Default site |
| `settings.defaultCertificate` | body | boolean | no | Default `false`; `true` only with `unknownHost` `site` | Complete TLS handshakes for unknown SNI with the default site's certificate |
| `settings.scan` | body | object | no | Default `{}` | Scan protection (platform-wide automatic bans) |
| `settings.scan.enabled` | body | boolean | no | Default `false` | Scan protection on |
| `settings.scan.threshold` | body | integer | no | 10–10000, default `100` | Requests to unknown hosts or by node IP within 60 seconds; one more bans |
| `settings.scan.banSeconds` | body | integer | no | 60–86400, default `3600` | Ban duration (seconds) |

Response: as `clusters.unknownHosts`.

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |
| `DEFAULT_SITE_INVALID` | 400 | The default site does not exist, belongs to another cluster or is disabled |
| `DEFAULT_SITE_CERTIFICATE_REQUIRED` | 409 | `defaultCertificate` is `true` and the default site has no certificate |

### `clusters.connectionLimits`

`GET /clusters/{clusterId}/connection-limits` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | yes | — | Cluster ID |

Response: `{ clusterId, settings, effectivePorts, nodes }`.

| Field | Type | Description |
| --- | --- | --- |
| `settings` | object | Fields of `settings` in `clusters.setConnectionLimits`; never set: `enabled: false`, `perIp: 256`, `newPerSecond: 50`, `burst: 100`, `ports: null` |
| `effectivePorts` | `array<object>` | Port ranges the nodes limit, `[{ start, end }]`: the merged `settings.ports`; with `ports` `null`, the listener ports and TCP L4 app ports of the latest revision |
| `nodes.total` | integer | Active nodes |
| `nodes.enforcing` | integer | Nodes enforcing the limits in the kernel |
| `nodes.unsupported` | `array<object>` | Active nodes without `conn-limit-v1`, `[{ id, name }]` |
| `nodes.failing` | `array<object>` | Nodes with `conn-limit-v1` that do not enforce the limits (such as without nftables), `[{ id, name, error }]`, `error` being the node's reason; `[]` while the limits are off |

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |

### `clusters.setConnectionLimits`

`PUT /clusters/{clusterId}/connection-limits` · write

Nodes limit TCP connections per IPv4 address or IPv6 /64 in the kernel (nftables) and drop packets over a limit; UDP is not limited.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | yes | — | Cluster ID |
| `settings` | body | object | yes | — | Connection limits |
| `settings.enabled` | body | boolean | yes | When on, `perIp` and `newPerSecond` are not both 0 | Limits on |
| `settings.perIp` | body | integer | yes | 0–100000; 0 means no limit | Concurrent connections per client |
| `settings.newPerSecond` | body | integer | yes | 0–100000; 0 means no limit | New connections per second per client |
| `settings.burst` | body | integer | yes | 0–1000000; when not 0, at least `newPerSecond`, and `newPerSecond` is not 0; 0 means `newPerSecond` | New connections above the rate a client may open at once |
| `settings.ports` | body | `array<object>` | yes | May be `null`; 1–64 ranges, not overlapping; saved sorted with adjacent ranges merged | Limited port ranges; `null` means the cluster's listener ports and TCP L4 app ports |
| `settings.ports[].start` | body | integer | yes | 1–65535 | First port |
| `settings.ports[].end` | body | integer | yes | 1–65535, not below `start` | Last port |

Response: as `clusters.connectionLimits`.

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |

### `clusters.setCache`

`PUT /clusters/{id}/cache` · write

A structural change: nodes rewrite the cache zone and reload nginx. A node may override the size with [`nodes.setCache`](#nodessetcache).

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Cluster ID |
| `maxSizeGb` | body | integer | yes | 1–65536 | Cache zone size on every node (GiB) |
| `inactiveDays` | body | integer | yes | 1–90 | Days unrequested objects stay |

Response: [Cluster](#cluster-object).

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |

## Enrollment tokens

- A token is single-use and stored as SHA-256 only; `token` is returned once, on creation.
- Audit: `enrollment_token.create`.
- Behaviour: [Adding a node](../../guide/clusters.en.md#adding-a-node) and [Enrollment and identity](../../deploy/nodes.en.md#enrollment-and-identity).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`clusters.createEnrollmentToken`](#clusterscreateenrollmenttoken) | `POST /enrollment-tokens` | write |
| [`clusters.getEnrollmentToken`](#clustersgetenrollmenttoken) | `GET /enrollment-tokens/{id}` | read |

### `clusters.createEnrollmentToken`

`POST /enrollment-tokens` · write · refuses `Idempotency-Key`

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | body | uuid | yes | — | Cluster the node joins |
| `nodeGroupId` | body | uuid | no | Must belong to `clusterId`; default the cluster's default node group | Node group the node joins |
| `nodeName` | body | string | no | At most 64 characters after trimming, default `""` | Name of the enrolled node; empty: the node's host name, without one `node-<first 8 characters of the token ID>` |
| `ttlMinutes` | body | integer | no | 5–10080, default `60` | Validity (minutes) |

Response:

| Field | Type | Description |
| --- | --- | --- |
| `tokenId` | uuid | Token ID, for `clusters.getEnrollmentToken` |
| `token` | string | Enrollment token, starting with `ewt_` |
| `expiresAt` | datetime | Expiry |
| `serverUrl` | string | Node channel URL in effect |
| `caSha256` | string | SHA-256 fingerprint of the node channel CA |
| `installCommand` | string | Install command, two lines: `export EDGEWEIR_TOKEN=…` and `curl -fsSL <console>/install.sh \| sudo --preserve-env=EDGEWEIR_TOKEN bash -s -- --server … --ca-sha256 …` |
| `warnings` | `array<enum>` | Addresses nodes on other networks may not reach: `console_url_local`, `console_url_private`, `console_url_http`, `node_api_url_local`, `node_api_url_private` |

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |
| `NODE_GROUP_NOT_FOUND` | 404 | The node group does not exist |
| `NODE_GROUP_CLUSTER_MISMATCH` | 400 | The node group belongs to another cluster |

### `clusters.getEnrollmentToken`

`GET /enrollment-tokens/{id}` · read

Never returns the token itself.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | `tokenId` |

Response: `{ tokenId, expiresAt, usedAt, node }`. `usedAt` is when the token was used, `null` before; `node` is the enrolled [Node](#node-object), `null` before use or after the node was deleted.

| Error | Status | Condition |
| --- | --- | --- |
| `ENROLLMENT_TOKEN_NOT_FOUND` | 404 | The token does not exist |

## Node groups

- Node group names are unique within a cluster. Each cluster has one default node group, which cannot be deleted.
- Audit: `node_group.create`, `node_group.update`, `node_group.delete`.
- Behaviour: [Node groups](../../guide/clusters.en.md#node-groups).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`nodeGroups.list`](#nodegroupslist) | `GET /node-groups` | read |
| [`nodeGroups.create`](#nodegroupscreate) | `POST /node-groups` | write |
| [`nodeGroups.update`](#nodegroupsupdate) | `PATCH /node-groups/{id}` | write |
| [`nodeGroups.delete`](#nodegroupsdelete) | `DELETE /node-groups/{id}` | write |

### `nodeGroups.list`

`GET /node-groups` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | query | uuid | no | — | Only this cluster's node groups; `[]` when the cluster does not exist |

Response: [Node group](#node-group-object)`[]`, the default group first, the rest oldest first.

### `nodeGroups.create`

`POST /node-groups` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | body | uuid | yes | — | Cluster ID |
| `name` | body | string | yes | 1–64 characters after trimming | Node group name |
| `regionId` | body | uuid | no | May be `null`, default `null` | Region |
| `isCanary` | body | boolean | no | Default `false` | Canary group: its nodes get candidate revisions first |

Response: [Node group](#node-group-object).

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |
| `NODE_GROUP_NAME_TAKEN` | 409 | The cluster has a node group of that name; `data.name` |
| `REGION_NOT_FOUND` | 404 | The region does not exist |

### `nodeGroups.update`

`PATCH /node-groups/{id}` · write

Changing `isCanary` changes the target revision of the group's nodes.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Node group ID |
| `name` | body | string | no | 1–64 characters after trimming; unchanged when omitted | Node group name |
| `regionId` | body | uuid | no | May be `null` (clears the region); unchanged when omitted | Region |
| `isCanary` | body | boolean | no | Unchanged when omitted | Canary group |

Response: [Node group](#node-group-object).

| Error | Status | Condition |
| --- | --- | --- |
| `NODE_GROUP_NOT_FOUND` | 404 | The node group does not exist |
| `NODE_GROUP_NAME_TAKEN` | 409 | The cluster has a node group of that name; `data.name` |
| `REGION_NOT_FOUND` | 404 | The region does not exist |

### `nodeGroups.delete`

`DELETE /node-groups/{id}` · write

The group's nodes move to the cluster's default node group.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Node group ID |

Response: `{ ok: true }`.

| Error | Status | Condition |
| --- | --- | --- |
| `NODE_GROUP_NOT_FOUND` | 404 | The node group does not exist |
| `NODE_GROUP_IS_DEFAULT` | 409 | The default node group cannot be deleted |

## Nodes

- Audit: `node.update` (rename, or rename and move), `node.move` (move only), `node.disable`, `node.enable`, `node.delete`, `node.set_probe`, `node.set_addresses`, `node.cache_update`.
- `nodes.setCache` publishes a revision with reason code `node_cache_updated` (`reasonParams.node`); `nodes.setAddresses` publishes the cluster's DNS revision (reason `manual`).
- Behaviour: [Nodes](../../guide/clusters.en.md#nodes), [Scheduling addresses and backup IPs](../../guide/scheduling.en.md#scheduling-addresses-and-backup-ips), [Nodes that also probe](../../guide/scheduling.en.md#nodes-that-also-probe).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`nodes.list`](#nodeslist) | `GET /nodes` | read |
| [`nodes.get`](#nodesget) | `GET /nodes/{id}` | read |
| [`nodes.update`](#nodesupdate) | `PATCH /nodes/{id}` | write |
| [`nodes.disable`](#nodesdisable) | `POST /nodes/{id}/disable` | write |
| [`nodes.enable`](#nodesenable) | `POST /nodes/{id}/enable` | write |
| [`nodes.delete`](#nodesdelete) | `DELETE /nodes/{id}` | write |
| [`nodes.setProbe`](#nodessetprobe) | `PUT /nodes/{id}/probe` | write |
| [`nodes.setAddresses`](#nodessetaddresses) | `PUT /nodes/{id}/addresses` | write |
| [`nodes.setCache`](#nodessetcache) | `PUT /nodes/{id}/cache` | write |

### `nodes.list`

`GET /nodes` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | query | uuid | no | — | Only this cluster's nodes; `[]` when the cluster does not exist |

Response: [Node](#node-object)`[]`, oldest first.

### `nodes.get`

`GET /nodes/{id}` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Node ID |

Response: [Node](#node-object).

| Error | Status | Condition |
| --- | --- | --- |
| `NODE_NOT_FOUND` | 404 | The node does not exist |

### `nodes.update`

`PATCH /nodes/{id}` · write

Moving a node into or out of a canary group changes its target revision.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Node ID |
| `name` | body | string | no | 1–64 characters after trimming; unchanged when omitted | Node name |
| `nodeGroupId` | body | uuid | no | A node group of the same cluster; `null` refused; unchanged when omitted | Node group |

Response: [Node](#node-object).

| Error | Status | Condition |
| --- | --- | --- |
| `NODE_NOT_FOUND` | 404 | The node does not exist |
| `NODE_GROUP_NOT_FOUND` | 404 | The node group does not exist |
| `NODE_GROUP_CLUSTER_MISMATCH` | 400 | The node group belongs to another cluster |

### `nodes.disable`

`POST /nodes/{id}/disable` · write

The node channel refuses a disabled node (except for certificate renewal); it keeps serving its last-known-good configuration. Its unfinished cache task deliveries are marked skipped, and it leaves unfinished upgrades.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Node ID |

Response: [Node](#node-object).

| Error | Status | Condition |
| --- | --- | --- |
| `NODE_NOT_FOUND` | 404 | The node does not exist |

### `nodes.enable`

`POST /nodes/{id}/enable` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Node ID |

Response: [Node](#node-object).

| Error | Status | Condition |
| --- | --- | --- |
| `NODE_NOT_FOUND` | 404 | The node does not exist |

### `nodes.delete`

`DELETE /nodes/{id}` · write

Deletes the node and revokes its client certificate (also the one a renewal replaced that is still accepted); the agent needs a new enrollment token to come back. The node leaves unfinished upgrades, and the results it measured as a probe are deleted.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Node ID |

Response: `{ ok: true }`.

| Error | Status | Condition |
| --- | --- | --- |
| `NODE_NOT_FOUND` | 404 | The node does not exist |

### `nodes.setProbe`

`PUT /nodes/{id}/probe` · write

The node probes the other nodes from its node group's region. Turning it off deletes the results it measured.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Node ID |
| `enabled` | body | boolean | yes | — | Also act as a probe |

Response: [Node](#node-object).

| Error | Status | Condition |
| --- | --- | --- |
| `NODE_NOT_FOUND` | 404 | The node does not exist |
| `NODE_REGION_REQUIRED` | 409 | Turning it on while the node's group has no region |

### `nodes.setAddresses`

`PUT /nodes/{id}/addresses` · write

Replaces the node's configured scheduling addresses; DNS and probes use them instead of the addresses the node reports.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Node ID |
| `addresses` | body | `array<object>` | yes | At most 8; when not empty, one has `level` 0; `[]` goes back to the public addresses the node reports | Scheduling addresses |
| `addresses[].address` | body | string | yes | 1–64 characters after trimming; a single unicast IP (private ranges included), no CIDR, no duplicates | Address |
| `addresses[].level` | body | integer | yes | 0–2 | 0 primary, 1 first backup, 2 second backup |

Response: [Node](#node-object).

| Error | Status | Condition |
| --- | --- | --- |
| `NODE_NOT_FOUND` | 404 | The node does not exist |
| `NODE_ADDRESS_INVALID` | 400 | An address is not a single unicast IP (CIDR, host name, loopback, link-local, multicast…) or is repeated; `data.address` |

### `nodes.setCache`

`PUT /nodes/{id}/cache` · write

Only this node reloads nginx. The node's own size takes effect once every active node of the cluster reports `cache-zone-v1`.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Node ID |
| `maxSizeGb` | body | integer | yes | 1–65536; may be `null` | The node's cache zone size (GiB); `null` uses the cluster's |

Response: [Node](#node-object).

| Error | Status | Condition |
| --- | --- | --- |
| `NODE_NOT_FOUND` | 404 | The node does not exist |

## Node logs

- Node logs need the node capability `node-logs-v1`, debug logs `debug-logs-v1`; `supported` in responses tells whether the node has it.
- For the demo account, client addresses in `fields.client` of entries are reduced.
- Audit: `node.debug_logs_pull`.
- Behaviour: [Node logs](../../guide/node-logs.en.md) and [Debug logs](../../guide/node-logs.en.md#debug-logs).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`nodes.logs`](#nodeslogs) | `GET /nodes/{id}/logs` | read |
| [`nodes.debugLogs`](#nodesdebuglogs) | `GET /nodes/{id}/debug-logs` | read |
| [`nodes.debugLog`](#nodesdebuglog) | `GET /nodes/{id}/debug-logs/{pullId}` | read |
| [`nodes.pullDebugLogs`](#nodespulldebuglogs) | `POST /nodes/{id}/debug-logs` | write |

### `nodes.logs`

`GET /nodes/{id}/logs` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Node ID |
| `minLevel` | query | enum | no | `info` / `warn` / `error`; default all | This level and above |
| `source` | query | enum | no | `agent` / `supervisor` / `nginx` / `lua` | Source |
| `from` | query | datetime | no | — | Happened on the node at or after |
| `to` | query | datetime | no | — | Happened on the node at or before |
| `q` | query | string | no | At most 200 characters after trimming | Message contains (any case) |
| `cursor` | query | string | no | At most 200 characters | `nextCursor` of the previous page (older entries) |
| `limit` | query | integer | no | 1–200, default `100` | Entries per page |

Response: `{ entries, nextCursor, supported }`. `entries` is [Node log entry](#node-log-entry-object)`[]`, newest first; `nextCursor` is `null` when there are no older entries.

| Error | Status | Condition |
| --- | --- | --- |
| `NODE_NOT_FOUND` | 404 | The node does not exist |
| `NODE_LOG_CURSOR_INVALID` | 400 | `cursor` cannot be read |

### `nodes.debugLogs`

`GET /nodes/{id}/debug-logs` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Node ID |

Response: `{ pulls, supported }`. `pulls` is [Debug log pull](#debug-log-pull-object)`[]` (without `entries`), newest first, at most 10; pulls past their deadline are failed first.

| Error | Status | Condition |
| --- | --- | --- |
| `NODE_NOT_FOUND` | 404 | The node does not exist |

### `nodes.debugLog`

`GET /nodes/{id}/debug-logs/{pullId}` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Node ID |
| `pullId` | path | uuid | yes | — | Pull ID |

Response: [Debug log pull](#debug-log-pull-object) with `entries`.

| Error | Status | Condition |
| --- | --- | --- |
| `NODE_DEBUG_LOG_NOT_FOUND` | 404 | The node has no such pull (also when the node does not exist) |

### `nodes.pullDebugLogs`

`POST /nodes/{id}/debug-logs` · write

Asks the node to upload its in-memory debug log buffer; a pull fails when the node has not uploaded within 120 seconds (`errorCode` `debug_logs_timeout`). A node has at most one open pull.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Node ID |
| `from` | body | datetime | no | Before `to` when both are given | Start |
| `to` | body | datetime | no | — | End |
| `components` | body | `array<string>` | no | At most 16, each 1–64 of `[a-z0-9_.-]`; default `[]` (no filter) | Components |
| `sources` | body | `array<enum>` | no | `agent` / `supervisor` / `nginx` / `lua`, at most 4; default `[]` (no filter) | Sources |

Response: [Debug log pull](#debug-log-pull-object) (without `entries`).

| Error | Status | Condition |
| --- | --- | --- |
| `NODE_NOT_FOUND` | 404 | The node does not exist |
| `NODE_CAPABILITY_REQUIRED` | 409 | The node lacks `debug-logs-v1`; `data.features`, `data.nodes` |
| `NODE_DEBUG_LOGS_BUSY` | 409 | The node has an open pull |

## Regions

- Region codes are unique.
- Audit: `region.create`, `region.update`, `region.delete`.
- Behaviour: [Regions](../../guide/clusters.en.md#regions).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`regions.list`](#regionslist) | `GET /regions` | read |
| [`regions.create`](#regionscreate) | `POST /regions` | write |
| [`regions.update`](#regionsupdate) | `PATCH /regions/{id}` | write |
| [`regions.delete`](#regionsdelete) | `DELETE /regions/{id}` | write |

### `regions.list`

`GET /regions` · read

No parameters.

Response: [Region](#region-object)`[]`, by code.

### `regions.create`

`POST /regions` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | body | string | yes | 1–64 characters after trimming | Region name |
| `code` | body | string | yes | After trimming and lowercasing 1–32 characters, lowercase letters, digits and `-`, starting with a letter or digit | Region code |

Response: [Region](#region-object).

| Error | Status | Condition |
| --- | --- | --- |
| `REGION_CODE_TAKEN` | 409 | The code is in use; `data.code` |

### `regions.update`

`PATCH /regions/{id}` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Region ID |
| `name` | body | string | no | As in `regions.create`; unchanged when omitted | Region name |
| `code` | body | string | no | As in `regions.create`; unchanged when omitted | Region code |

Response: [Region](#region-object).

| Error | Status | Condition |
| --- | --- | --- |
| `REGION_NOT_FOUND` | 404 | The region does not exist |
| `REGION_CODE_TAKEN` | 409 | Another region uses the code; `data.code` |

### `regions.delete`

`DELETE /regions/{id}` · write

Node groups that referenced the region stay, without a region.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Region ID |

Response: `{ ok: true }`.

| Error | Status | Condition |
| --- | --- | --- |
| `REGION_NOT_FOUND` | 404 | The region does not exist |
| `REGION_IN_USE` | 409 | Probes belong to the region; `data.probes` is their count |

## Node upgrades

- An upgrade covers every active node of the cluster: the nodes of the chosen group are the canary (`canary`), the others `rollout`; after promotion they follow in batches, with at most 25% of the `rollout` nodes (at least one) upgrading at once.
- Audit: `node.upgrade_create`, `node.upgrade_promote`, `node.upgrade_cancel`.
- Prerequisites, states and the checks on the node: [Node upgrades](../../guide/node-upgrades.en.md).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`upgrades.release`](#upgradesrelease) | `GET /node-releases/{version}` | read |
| [`upgrades.latestVersion`](#upgradeslatestversion) | `GET /node-upgrades/latest-version` | read |
| [`upgrades.list`](#upgradeslist) | `GET /node-upgrades` | read |
| [`upgrades.create`](#upgradescreate) | `POST /node-upgrades` | write |
| [`upgrades.promote`](#upgradespromote) | `POST /node-upgrades/{id}/promote` | write |
| [`upgrades.cancel`](#upgradescancel) | `POST /node-upgrades/{id}/cancel` | write |

### `upgrades.release`

`GET /node-releases/{version}` · read

Reads `v<version>/checksums.txt` from the node release source (at most 2 MiB, 15-second timeout).

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `version` | path | string | yes | `major.minor.patch`, optionally with a `-prerelease` suffix, at most 64 characters; a leading `v` is dropped | Version |

Response: `{ version, artifacts }`. `artifacts` has one item per supported architecture, `{ arch, archiveUrl, sha256, checksumsUrl, signatureUrl }`: `arch` is `amd64` / `arm64`; `archiveUrl` points to `edgeweir-node_<version>_linux_<arch>.tar.gz`; `signatureUrl` to `checksums.txt.sigstore.json`.

| Error | Status | Condition |
| --- | --- | --- |
| `UPGRADE_RELEASE_UNAVAILABLE` | 502 | The manifest cannot be read, lists an archive twice, or has no supported archive |

### `upgrades.latestVersion`

`GET /node-upgrades/latest-version` · read

A GitHub release source is asked through the releases API, a mirror through `<source>/latest`. Cached per source for 10 minutes, a failed lookup for 1 minute.

No parameters.

Response: `{ version }`, `version` being `null` when it cannot be told.

### `upgrades.list`

`GET /node-upgrades` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | query | uuid | no | — | Only this cluster's upgrades |

Response: [Upgrade](#upgrade-object)`[]`, newest first, at most 50.

### `upgrades.create`

`POST /node-upgrades` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `version` | body | string | yes | As in `upgrades.release` | Target version |
| `nodeGroupId` | body | uuid | yes | — | Node group upgraded first (the canary) |

Response: [Upgrade](#upgrade-object).

| Error | Status | Condition |
| --- | --- | --- |
| `UPGRADE_RELEASE_UNAVAILABLE` | 502 | As in `upgrades.release` |
| `NODE_GROUP_NOT_FOUND` | 404 | The node group does not exist |
| `UPGRADE_TOO_MANY_NODES` | 409 | The cluster has more active nodes than `data.limit` (1000) |
| `UPGRADE_CANARY_EMPTY` | 409 | The chosen node group has no active nodes |
| `UPGRADE_NODES_UNAVAILABLE` | 409 | An active node fails a prerequisite (Linux, an archive for its architecture, `self-upgrade-v1`, online, healthy data plane, target revision applied); `data.nodes` (at most 10, then `+N`) |
| `UPGRADE_BUSY` | 409 | A node is already in an unfinished upgrade; `data.nodes` |

### `upgrades.promote`

`POST /node-upgrades/{id}/promote` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Upgrade ID |

Response: [Upgrade](#upgrade-object).

| Error | Status | Condition |
| --- | --- | --- |
| `UPGRADE_NOT_FOUND` | 404 | The upgrade does not exist |
| `UPGRADE_NOT_READY` | 409 | `canPromote` is `false` |

### `upgrades.cancel`

`POST /node-upgrades/{id}/cancel` · write

Cancels the `held` and `pending` deliveries; the upgrade becomes `cancelled`.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Upgrade ID |

Response: [Upgrade](#upgrade-object).

| Error | Status | Condition |
| --- | --- | --- |
| `UPGRADE_NOT_FOUND` | 404 | The upgrade does not exist |
| `UPGRADE_BUSY` | 409 | A node is upgrading (`running`); `data.nodes` |
| `UPGRADE_FINISHED` | 409 | The upgrade is not `canary` or `rollout` |

## Port pools and L4 apps

- Revision reason codes: `l4_app_created`, `l4_app_updated`, `l4_app_deleted` (`reasonParams.app` is the app name). `clusters.setPortPools` publishes no revision.
- Audit: `cluster.port_pools_update`, `l4_app.create`, `l4_app.update`, `l4_app.enable`, `l4_app.disable`, `l4_app.delete`, `l4.cname_update`.
- Node capabilities: a configuration with L4 apps needs `l4-v1`; port ranges, `originPortMode: same` and TLS termination need `l4-v2`.
- Limits: at most 256 apps per cluster (disabled ones included) and 2048 app ports per cluster (ranges counted in full).
- Behaviour: [L4 forwarding](../../guide/l4.en.md).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`clusters.portPools`](#clustersportpools) | `GET /clusters/{clusterId}/port-pools` | read |
| [`clusters.setPortPools`](#clusterssetportpools) | `PUT /clusters/{clusterId}/port-pools` | write |
| [`l4Apps.list`](#l4appslist) | `GET /l4-apps` | read |
| [`l4Apps.get`](#l4appsget) | `GET /l4-apps/{id}` | read |
| [`l4Apps.create`](#l4appscreate) | `POST /l4-apps` | write |
| [`l4Apps.update`](#l4appsupdate) | `PATCH /l4-apps/{id}` | write |
| [`l4Apps.delete`](#l4appsdelete) | `DELETE /l4-apps/{id}` | write |
| [`l4Apps.setEnabled`](#l4appssetenabled) | `PUT /l4-apps/{id}/enabled` | write |
| [`l4Apps.setCnamePrefix`](#l4appssetcnameprefix) | `PUT /l4-apps/{id}/cname-prefix` | write |
| [`l4Apps.stats`](#l4appsstats) | `GET /l4-apps/{id}/stats` | read |

### `clusters.portPools`

`GET /clusters/{clusterId}/port-pools` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | yes | — | Cluster ID |

Response:

| Field | Type | Description |
| --- | --- | --- |
| `clusterId` | uuid | Cluster ID |
| `pools` | `array<object>` | Port pools `[{ protocol, from, to }]`, by first port, then protocol; `protocol` is `tcp` / `udp` / `both` |
| `reservedPorts` | `array<integer>` | Ports of the cluster's HTTP / HTTPS listeners (80, 443, the extra ports and the listener ports of the latest revision); never part of a pool |
| `nodesWithoutL4` | `array<object>` | Active nodes without `l4-v1`, `[{ id, name }]`; they refuse configurations with L4 apps until upgraded |
| `nodesWithoutL4V2` | `array<object>` | Active nodes without `l4-v2`, `[{ id, name }]` |

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |

### `clusters.setPortPools`

`PUT /clusters/{clusterId}/port-pools` · write

Replaces the port pools.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | yes | — | Cluster ID |
| `pools` | body | `array<object>` | yes | At most 64 | Port pools |
| `pools[].protocol` | body | enum | yes | `tcp` / `udp` / `both` | `both` counts for TCP and UDP |
| `pools[].from` | body | integer | yes | 1024–65535 | First port (inclusive) |
| `pools[].to` | body | integer | yes | 1024–65535, not below `from` | Last port (inclusive) |

Response: as `clusters.portPools`.

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |
| `L4_PORT_POOL_OVERLAP` | 400 | Pools of a protocol overlap (`both` overlaps `tcp` and `udp`); `data.pools` (`from-to/protocol`, comma-separated) |
| `L4_PORT_RESERVED` | 400 | A pool contains a port of the cluster's HTTP / HTTPS listeners; `data.port` |
| `L4_PORT_IN_USE` | 409 | The new pools would leave an app's port (disabled apps included) outside; `data.apps` (`name (port/protocol)`, comma-separated) |

### `l4Apps.list`

`GET /l4-apps` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | query | uuid | no | — | Only this cluster's apps |

Response: [L4 app](#l4-app-object)`[]`, by port, then protocol.

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The given cluster does not exist |

### `l4Apps.get`

`GET /l4-apps/{id}` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | App ID |

Response: [L4 app](#l4-app-object).

| Error | Status | Condition |
| --- | --- | --- |
| `L4_APP_NOT_FOUND` | 404 | The app does not exist |

### `l4Apps.create`

`POST /l4-apps` · write · `201`

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | body | uuid | yes | — | Cluster ID |
| `name` | body | string | yes | 1–100 characters after trimming | App name |
| `protocol` | body | enum | yes | `tcp` / `udp` | Protocol |
| `port` | body | integer | yes | 1024–65535; inside a port pool of the cluster for the protocol | Listening port (first port of a range) |
| `portEnd` | body | integer | no | 1024–65535, may be `null`, default `null`; above `port`, at most 1000 ports in the range, all inside one pool | Last port of a range; `null` for a single port |
| `originPortMode` | body | enum | no | `fixed` / `same`, default `fixed` | `fixed`: each origin's `port`; `same`: the port the connection arrived on |
| `certificateId` | body | uuid | no | May be `null`, default `null`; TCP only; issued and unexpired | The node terminates TLS with this certificate and forwards plain TCP; the SNI must be one of its names; `null` for plain TCP |
| `tlsMinimumVersion` | body | enum | no | `1.2` / `1.3`, default `1.2` | Minimum TLS version |
| `enabled` | body | boolean | no | Default `true` | Enabled |
| `acceptProxyProtocol` | body | boolean | no | Default `false`; TCP only | The listener expects a PROXY protocol header (v1 or v2) |
| `proxyProtocolVersion` | body | integer | no | 0–2, default `0`; not 0 for TCP only | PROXY protocol version sent to the origins; 0 sends none |
| `origins` | body | `array<object>` | yes | 1–32, at least one with `backup` `false` | Origins |
| `origins[].address` | body | string | yes | Host name or IP, 1–253 characters; the origin address policy applies as for sites | Origin address |
| `origins[].port` | body | integer | no | 1–65535; required with `originPortMode` `fixed`, ignored with `same` (saved as 0) | Origin port |
| `origins[].weight` | body | integer | no | 1–100, default `1` | Weight |
| `origins[].backup` | body | boolean | no | Default `false` | Backup origin: used only while every other origin is down |
| `maxFails` | body | integer | no | 1–100, default `3` | Passive health check: consecutive connection failures that take an origin out |
| `failTimeoutSeconds` | body | integer | no | 1–3600, default `30` | Passive health check: seconds before a failed origin is tried again |
| `connectTimeoutMs` | body | integer | no | 100–60000, default `5000` | Origin connect timeout (ms) |
| `idleTimeoutSeconds` | body | integer | no | 1–86400; omitted: `600` for TCP, `30` for UDP | Idle timeout of a connection (TCP) or session (UDP) |
| `allowListIds` | body | `array<uuid>` | no | At most 16, deduplicated; default `[]` | Accept only addresses of these IP lists; empty accepts every address |
| `blockListIds` | body | `array<uuid>` | no | At most 16, deduplicated; default `[]` | Refuse addresses of these IP lists |
| `maxConnections` | body | integer | no | 0–10000000, default `0` | Concurrent connections or sessions per node; 0 means no limit |
| `newConnectionsPerSecond` | body | integer | no | 0–1000000, default `0` | New connections or sessions per second and node; 0 means no limit |

Response: `{ app, revision }`: the [L4 app](#l4-app-object) and the published [Revision](#revision-object). A new app's `cnamePrefix` is 8 random characters.

| Error | Status | Condition |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |
| `L4_APP_LIMIT` | 409 | The cluster already has 256 apps; `data.limit` |
| `L4_PROXY_PROTOCOL_UNSUPPORTED` | 400 | A UDP app with `acceptProxyProtocol` or a non-zero `proxyProtocolVersion` |
| `L4_TLS_UNSUPPORTED` | 400 | A UDP app with `certificateId` |
| `L4_PORT_RANGE_INVALID` | 400 | `portEnd` is not above `port`, or the range holds more than `data.max` (1000) ports |
| `L4_PORT_RESERVED` | 400 | A port of the cluster's HTTP / HTTPS listeners; `data.port` |
| `L4_PORT_OUTSIDE_POOL` | 400 | A port outside the cluster's pools for the protocol; `data.port` is the first such port |
| `L4_PORT_IN_USE` | 409 | Another app of the cluster (disabled ones included) uses the port and protocol; `data.apps` |
| `L4_PORT_LIMIT` | 409 | The cluster's app ports would exceed `data.limit` (2048) |
| `CERTIFICATE_NOT_FOUND` | 404 | The certificate does not exist |
| `L4_CERTIFICATE_UNAVAILABLE` | 400 | The certificate is not issued yet or has expired |
| `CERTIFICATE_CHAIN_EXPLICIT_CURVE` | 400 | The certificate's EC public key does not name its curve; nodes cannot load it |
| `CERTIFICATE_KEY_EXPLICIT_CURVE` | 400 | The certificate's EC private key does not name its curve; nodes cannot load it |
| `IP_LIST_NOT_FOUND` | 404 | A list in `allowListIds` or `blockListIds` does not exist |
| `ORIGIN_ADDRESS_FORBIDDEN` | 400 | An origin is a special-purpose address not in the origin address allow list; `data.address`, `data.range` |
| `L4_ORIGIN_PORT_REQUIRED` | 400 | An origin without `port` while `originPortMode` is `fixed` |

### `l4Apps.update`

`PATCH /l4-apps/{id}` · write

Changes the fields given; the result is checked as in `l4Apps.create`. `origins` replaces the list; an origin with the address and port of an existing one keeps its ID (and with it the nodes' passive health state). Changing `protocol` does not change `idleTimeoutSeconds`. Changing `originPortMode` alone rewrites the saved origin ports for the new mode: to `same` they are saved as 0; from `same` to `fixed` without `origins` the request fails with `L4_ORIGIN_PORT_REQUIRED`.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | App ID |
| `expectedUpdatedAt` | body | datetime | no | — | Optimistic concurrency: the `updatedAt` last read |
| `name`, `protocol`, `port`, `portEnd`, `originPortMode`, `certificateId`, `tlsMinimumVersion`, `acceptProxyProtocol`, `proxyProtocolVersion`, `origins`, `maxFails`, `failTimeoutSeconds`, `connectTimeoutMs`, `idleTimeoutSeconds`, `allowListIds`, `blockListIds`, `maxConnections`, `newConnectionsPerSecond` | body | — | no | As in `l4Apps.create`, without defaults; unchanged when omitted | As in `l4Apps.create` |

Response: `{ app, revision }`.

| Error | Status | Condition |
| --- | --- | --- |
| `L4_APP_NOT_FOUND` | 404 | The app does not exist |
| `UPDATED_AT_MISMATCH` | 409 | `expectedUpdatedAt` is not the current value; `data.updatedAt` |
| `L4_PROXY_PROTOCOL_UNSUPPORTED` and others | — | As in `l4Apps.create` (except `CLUSTER_NOT_FOUND` and `L4_APP_LIMIT`) |

### `l4Apps.delete`

`DELETE /l4-apps/{id}` · write

Deletes the app with its origins and statistics.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | App ID |

Response: `{ revision }`: the published [Revision](#revision-object).

| Error | Status | Condition |
| --- | --- | --- |
| `L4_APP_NOT_FOUND` | 404 | The app does not exist |

### `l4Apps.setEnabled`

`PUT /l4-apps/{id}/enabled` · write

A disabled app keeps its port and settings; it is not shipped to nodes and has no DNS record. When `enabled` equals the current state, nothing is published or audited, `expectedUpdatedAt` is not checked, and the latest revision is returned.

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | App ID |
| `enabled` | body | boolean | yes | — | Enabled |
| `expectedUpdatedAt` | body | datetime | no | — | Optimistic concurrency: the `updatedAt` last read |

Response: `{ app, revision }`.

| Error | Status | Condition |
| --- | --- | --- |
| `L4_APP_NOT_FOUND` | 404 | The app does not exist |
| `UPDATED_AT_MISMATCH` | 409 | `expectedUpdatedAt` is not the current value; `data.updatedAt` |

### `l4Apps.setCnamePrefix`

`PUT /l4-apps/{id}/cname-prefix` · write

Sets the first label of the app's CNAME target; without `prefix`, a new random one. The replaced name keeps resolving for 24 hours when the cluster's automatic DNS had published it. A changed prefix publishes the cluster's DNS revision (reason `cname`). Rules: [CNAME prefixes](../../guide/domains.en.md#cname-prefixes).

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | App ID |
| `prefix` | body | string | no | After trimming and lowercasing 1–30 of `[a-z0-9-]`, not starting or ending with `-`; unique across sites and apps (replaced prefixes still resolving included), not `all`, `all-<n>` or a record name of a DNS binding. A UUID is accepted only as the app's own prefix from before CNAME prefixes (its current one, or one replaced within 24 hours) | New prefix |

Response: `{ prefix, retired }`. `retired` lists replaced prefixes still resolving, `[{ prefix, expiresAt }]`.

| Error | Status | Condition |
| --- | --- | --- |
| `L4_APP_NOT_FOUND` | 404 | The app does not exist |
| `CNAME_PREFIX_INVALID` | 400 | `prefix` is a UUID that is not the app's; `data.prefix` |
| `CNAME_PREFIX_CONFLICT` | 409 | The prefix is taken or reserved, or the zone of the automatic DNS holds a record at that name the cluster does not manage; `data.prefix` |

### `l4Apps.stats`

`GET /l4-apps/{id}/stats` · read

The range is `[from, to)`. Per-minute counters are summed over nodes (a minute's `peakConcurrent` is the sum of the nodes' peaks).

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | App ID |
| `from` | query | datetime | yes | Before `to`; at most 7 days | Start |
| `to` | query | datetime | yes | — | End |

Response:

| Field | Type | Description |
| --- | --- | --- |
| `appId` | uuid | App ID |
| `from`, `to` | datetime | The range |
| `bucketSeconds` | integer | Width of a point: 60 for ranges up to a day, 300 up to five days, else 3600 |
| `points` | `array<object>` | One `{ time, …counters }` per bucket from the bucket of `from`, oldest first; empty buckets are zero |
| `totals` | object | Counters over the range |
| `nodes` | `array<object>` | Each node that reported, `{ nodeId, nodeName, …counters }`, most connections first |

Counters: `connections` (TCP connections or UDP sessions accepted), `refused` (refused by the IP lists or the limits), `peakConcurrent` (in `points` and `totals` the highest per-minute sum of peaks in the bucket or range, in `nodes` the node's own highest), `bytesReceived` (bytes from clients), `bytesSent` (bytes to clients).

| Error | Status | Condition |
| --- | --- | --- |
| `L4_APP_NOT_FOUND` | 404 | The app does not exist |

## Objects

### Cluster object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Cluster ID |
| `name` | string | Name |
| `description` | string | Description |
| `nodeCount` | integer | Nodes (disabled ones included) |
| `onlineNodeCount` | integer | Online nodes (disabled ones included) |
| `liveNodeCount` | integer | Online active nodes: what the configuration is delivered to now |
| `appliedNodeCount` | integer | Of those, nodes running their target revision (with a canary running: stable or candidate) |
| `siteCount` | integer | Sites |
| `latestRevision` | object | The latest [Revision](#revision-object), or `null` |
| `clientIpMode` | enum | Client address mode: `direct` / `proxy_protocol` / `header`; details in `clusters.clientIp` |
| `cache.maxSizeGb` | integer | Cache zone size on every node (GiB); a node may override it |
| `cache.inactiveDays` | integer | Days unrequested objects stay |
| `createdAt` | datetime | Created |

### Revision object

| Field | Type | Description |
| --- | --- | --- |
| `clusterId` | uuid | Cluster ID |
| `revision` | integer | Revision number |
| `contentHash` | string | Content hash |
| `siteCount` | integer | Sites in the revision |
| `reason` | string | English reason text |
| `reasonCode` | string | Reason code; `""` for revisions published before reason codes existed |
| `reasonParams` | object | Reason parameters, string or number values |
| `createdAt` | datetime | Published |

### Rollout object

| Field | Type | Description |
| --- | --- | --- |
| `clusterId` | uuid | Cluster ID |
| `policy` | object | Policy: `enabled`, `windowSeconds`, `autoPromote`, `errorRatioMultiplier`, `errorRatioFloor`, `minRequests`, as in `clusters.setRolloutPolicy` |
| `state` | enum | `idle`, `canary`, `awaiting_promotion`, `promoted`, `rolled_back`, `direct`; `idle` while the policy is off |
| `stableRevision` | integer | Revision of the non-canary nodes, or `null` |
| `candidateRevision` | integer | Revision of the canary nodes while a rollout runs, or `null` |
| `lastCandidateRevision` | integer | The candidate promoted or rolled back last, or `null` |
| `windowStartedAt` | datetime | Observation window start, or `null` |
| `windowEndsAt` | datetime | Observation window end, or `null` |
| `outcome` | enum | `""`, `auto_promote`, `manual_promote`, `apply_failed`, `apply_timeout`, `unhealthy`, `error_ratio`, `manual_abort`, `no_canary`, `policy_disabled`, `manual_rollback`, `withdrawn` |
| `finishedAt` | datetime | End of the last rollout, or `null` |
| `canaryNodes` | `array<object>` | Active nodes of canary groups, and nodes of the running window that left them: `{ id, name, online, appliedRevision, participating }`, `participating` meaning part of the running window |
| `window` | object | Traffic of the running window `{ canaryRequests, canary5xx, baselineRequests, baseline5xx }`, `null` without a running rollout |
| `candidateChanges` | object | While a rollout runs, `{ sites: { added, changed, removed }, reasons }`: sites the candidate adds, changes and removes against the stable revision (`[{ id, name }]`), and the [Revisions](#revision-object) published after the stable one (without repeated reasons); otherwise `null` |
| `policyUpdatedAt` | datetime | Last policy change; `expectedUpdatedAt` of `clusters.setRolloutPolicy` compares with it |
| `updatedAt` | datetime | Last change of any kind (every rollout step) |

### Node group object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Node group ID |
| `clusterId` | uuid | Cluster ID |
| `name` | string | Name |
| `isDefault` | boolean | The cluster's default node group |
| `isCanary` | boolean | Canary group: its nodes get candidate revisions first |
| `regionId` | uuid | Region ID, or `null` |
| `regionName` | string | Region name, or `null` |
| `regionCode` | string | Region code, or `null` |
| `nodeCount` | integer | Nodes |
| `createdAt` | datetime | Created |

### Region object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Region ID |
| `name` | string | Name |
| `code` | string | Code |
| `nodeGroupCount` | integer | Node groups using the region |
| `createdAt` | datetime | Created |

### Node object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Node ID |
| `name` | string | Name |
| `clusterId` | uuid | Cluster ID |
| `clusterName` | string | Cluster name |
| `nodeGroupId` | uuid | Node group ID, or `null` |
| `nodeGroupName` | string | Node group name, or `null` |
| `regionName` | string | Region name of the node group, or `null` |
| `hostname` | string | Host name |
| `status` | enum | `active` / `disabled` |
| `online` | boolean | Online |
| `lastSeenAt` | datetime | Last heartbeat, or `null` |
| `enrolledAt` | datetime | Enrolled, or `null` |
| `agentVersion` | string | Agent version |
| `supportedFeatures` | `array<string>` | Capabilities the node reports, see below |
| `upgradeRequired` | boolean | The node lacks a capability the cluster's latest configuration requires, or lacks `stats-sequence-v1` |
| `engine` | string | Data-plane engine |
| `engineVersion` | string | Engine version |
| `os` | string | Operating system |
| `arch` | string | Architecture |
| `ipAddresses` | `array<string>` | Addresses the node reports, sorted (configured ones are in `schedulingAddresses`) |
| `certFingerprint` | string | Client certificate fingerprint, or `null` |
| `certNotAfter` | datetime | Client certificate expiry, or `null` |
| `appliedRevision` | integer | Applied revision number; 0 without one |
| `appliedContentHash` | string | Content hash of the applied revision; `""` without one |
| `targetRevision` | integer | Revision the node should run (with a canary running: stable or candidate), or `null` |
| `applyState` | enum | `applying` / `applied` / `failed`, or `null` |
| `applyMessage` | string | Apply message |
| `dataPlaneHealthy` | boolean | Data plane healthy |
| `banStatus` | object | Dynamic ban state from the last heartbeat (nodes with `bans-v1`), else `null` |
| `banStatus.appliedSequence` | string | Highest ban sequence applied to the data plane (decimal) |
| `banStatus.entries` | integer | Ban entries |
| `banStatus.capacity` | integer | Ban capacity |
| `banStatus.unappliedIds` | `array<string>` | Manual bans the node could not hold (at most 100 IDs) |
| `banStatus.unapplied` | integer | Manual bans the node could not hold |
| `banStatus.kernelEntries` | integer | Platform bans held by nftables (`kernel-ban-v1`) |
| `banStatus.autoEvicted` | string | Automatic bans dropped to make room since the agent started (decimal) |
| `banStatus.reportedAt` | datetime | Reported |
| `banStatus.connectionLimitsActive` | boolean | Optional; the cluster's connection limits are enforced in the kernel (`conn-limit-v1`) |
| `banStatus.connectionLimitsError` | string | Optional; why they are not (the node's message) |
| `probeEnabled` | boolean | Also acts as a probe |
| `metrics` | object | Host metrics of the last heartbeat (`metrics-v1`), `null` until the node reports them |
| `metrics.cpuPercent` | number | CPU used by the whole host, 0–100 |
| `metrics.load1`, `metrics.load5`, `metrics.load15` | number | Load |
| `metrics.memoryUsedBytes`, `metrics.memoryTotalBytes` | number | Used and total memory (bytes) |
| `metrics.egressBps` | number | Bits per second sent on non-loopback interfaces |
| `metrics.activeConnections` | number | Active connections |
| `metrics.reportedAt` | datetime | Reported |
| `schedulingAddresses` | `array<object>` | Addresses DNS and probes use, `{ address, level, source, reachable }`: `source` is `configured` (set by the operator, with a level) or `reported` (a public address the node reports while none is configured, level 0); `reachable` is `false` while the probes count it as down |
| `schedulingLevel` | integer | Address level DNS uses now (0 primary; higher while lower levels are unreachable) |
| `remoteAddress` | string | Source address of the node's latest connection to the console (its public address behind NAT, or a proxy's), `null` before it connects |
| `dnsIssue` | enum | `no_public_address`: the node reports no public address and none is configured, so DNS cannot answer with it; else `null` |
| `authError` | string | Why the node channel refused the node's own certificate since its last heartbeat (an OpenSSL verify code; `CERT_HAS_EXPIRED` means it must enroll again), else `null` |
| `cache.maxSizeGb` | integer | The node's own cache zone size (GiB), or `null` (the cluster's) |
| `cache.usage` | object | Cache disk usage as last measured, `{ usedBytes, maxBytes, measuredAt }`; `null` until a node with `cache-zone-v1` reports it |
| `certificateFailures` | `array<object>` | Certificates of the applied revision the node could not load (`certificate-isolation-v1`): `{ certificateId, certificateName, reason, servingEarlier }`; `certificateName` is `""` when the certificate no longer exists; `reason` is `invalid_material` / `fingerprint_mismatch` / `unavailable`; `servingEarlier` `true` means the node serves the certificate's earlier material, else it refuses its handshakes |
| `channel` | object | The node channel address the node uses, `null` until it connects with a console that records it |
| `channel.url` | string | Address the node reports (`channel-follow-v1`), `null` for older agents |
| `channel.serverName` | string | Server name checked at that address |
| `channel.fallbackUrl` | string | Address before the last switch, tried while `url` fails, or `null` |
| `channel.fallbackServerName` | string | Server name of the fallback |
| `channel.onFallback` | boolean | Running on the fallback because `url` failed |
| `channel.source` | enum | How `url` was set: `enroll` / `console` / `command` (`edgeweir-node set-server`), or `null` |
| `channel.switchedAt` | datetime | Switched, or `null` |
| `channel.error` | object | Last failed address check `{ code, message, url, serverName, at }`, `code` being `unreachable`, `websocket_refused`, `tls_untrusted`, `rejected`, `wrong_identity` or `invalid_address` and `message` the agent's; or `null` |
| `channel.observedServerName` | string | TLS server name of the latest connection; `""` when it sent none (an IP address) |
| `channel.observedWebSocket` | boolean | The latest connection came through the WebSocket entry |
| `channel.observedAt` | datetime | Latest connection |
| `clock` | object | The node's clock against the console's, `{ offsetMs, measuredAt, skewed }`: positive `offsetMs` means the node is ahead; `skewed` means the offset reaches the alert policy's `clockSkewSeconds`; `null` for nodes before v1.5.0 |
| `location` | object | Where the node's public address is, from the node's GeoIP databases, `{ address, country, subdivision, latitude, longitude }`: `country` is ISO 3166-1 alpha-2, `""` when unknown; coordinates need a City MMDB, else `null`; `null` for nodes before v1.6.2 |

Capabilities in `supportedFeatures` the console tells apart (every capability a feature requires: [Node capabilities](../../guide/node-upgrades.en.md#node-capabilities)):

| Capability | Meaning |
| --- | --- |
| `purge-tag-v1` | Purges by host and Cache-Tag; such tasks are refused while an active node of the cluster lacks it |
| `prefetch-v2` | Prefetch device variants and sitemap tasks |
| `probe-health-v1` | Health endpoint `/.edgeweir/health` on the edge listeners; probes use HTTP / HTTPS when every active node of the cluster has it |
| `metrics-v1` | Host metrics in heartbeats (`metrics`) |
| `rule-log-v1` | Per-minute matches of rules with the log action |
| `stats-dims-v1` | Statistics dimensions |
| `origin-stats-v1` | Per-minute fetches of each origin |
| `l4-v1` | L4 apps and their statistics |
| `l4-v2` | L4 port ranges, origins on the arriving port and TLS termination |
| `cache-zone-v1` | A node's own cache zone size and cache usage in heartbeats |
| `auth-identity-headers-v1` | Removes identity headers of disabled and former access authentication rules; never required |
| `certificate-isolation-v1` | A certificate that cannot be loaded is left out and reported (`certificateFailures`); never required |
| `encoded-path-exemptions-v1` | A site's encoded path exemptions; never required |
| `channel-follow-v1` | Reports and follows the node channel address the console gives out (`channel`) |
| `node-logs-v1` | Uploads node logs; never required |
| `debug-logs-v1` | Debug log buffer and pulls; never required, `nodes.pullDebugLogs` is refused without it |
| `geoip-city-v1`, `geoip-country-v1`, `geoip-subdivision-v1` | GeoIP country and subdivision data; for nodes without `geoip-country-v1`, `geoip-city-v1` stands for subdivision data |
| `edge-ports-v1`, `client-ip-v1`, `unknown-host-v1`, `conn-limit-v1` | Cluster network settings, see [Cluster network settings](#cluster-network-settings-listen-ports-client-ip-unknown-hosts-connection-limits-cache-zone) |
| `self-upgrade-v1` | Signed upgrades; required by `upgrades.create` |
| `stats-sequence-v1` | Statistics reports with sequence numbers; without it `upgradeRequired` is always `true` |
| `bans-v1`, `kernel-ban-v1` | Dynamic bans (`banStatus`) and platform bans in nftables |

### Node log entry object

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Entry ID |
| `time` | datetime | When it happened on the node |
| `receivedAt` | datetime | When the console received it |
| `kind` | enum | `entry`: an entry the node uploaded; `dropped`: how many entries the node dropped before a batch |
| `level` | enum | `info` / `warn` / `error` |
| `source` | enum | `agent` / `supervisor` / `nginx` / `lua` |
| `component` | string | Component |
| `message` | string | Message, redacted |
| `fields` | object | Fields (string → string), redacted |
| `repeated` | integer | Identical entries the node folded into this one |
| `truncated` | boolean | Truncated |
| `event` | string | Event of an `info` entry: `agent_started`, `config_applied`, `last_known_good`, `engine_started`, `certificate_renewed`, `channel_switched`, `upgrade_applied`, `engine_logs_unavailable`; `""` otherwise |
| `dropped` | object | With `kind` `dropped`, `{ rateLimited, overflow }` (entries over the node's rate limits and for its buffers), else `null` |

### Debug log pull object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Pull ID |
| `nodeId` | uuid | Node ID |
| `state` | enum | `pending` / `running` / `succeeded` / `failed` |
| `from`, `to` | datetime | Time filter of the pull, or `null` |
| `components` | `array<string>` | Component filter; empty for none |
| `sources` | `array<enum>` | Source filter; empty for none |
| `createdAt` | datetime | Created |
| `deadlineAt` | datetime | When an unanswered pull fails |
| `finishedAt` | datetime | Finished, or `null` |
| `errorCode` | string | `debug_logs_timeout`, `debug_logs_failed` (`errorParams.reason` `disabled` / `upload_failed`), `task_unsupported`; `""` on success |
| `errorParams` | object | Error parameters (string → string) |
| `entryCount` | integer | Entries |
| `truncated` | boolean | Older matching entries were left out for the upload limits (10000 entries, 4 MiB) |
| `bufferSince` | datetime | Oldest entry the node still held (nothing older can be in the pull), or `null` |
| `overwritten` | integer | Entries the node's buffers overwrote for their capacity since they started |
| `supervisorMissing` | boolean | The supervisor's entries (and OpenResty's under it) could not be read |
| `entries` | `array<object>` | `nodes.debugLog` only: entries `{ time, level, source, component, message, fields, truncated, event }`, oldest first; `level` is `debug` / `info` / `warn` / `error`; `[]` until the node uploads |

### Upgrade object

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Upgrade ID |
| `clusterId` | string | Cluster ID |
| `clusterName` | string | Cluster name |
| `groupName` | string | Name of the node group upgraded first |
| `version` | string | Target version |
| `state` | enum | `canary`, `rollout`, `succeeded`, `failed`, `cancelled` |
| `createdAt` | string | Created (ISO 8601) |
| `canPromote` | boolean | State `canary`, `rollout` nodes waiting, and every canary node succeeded, runs the target version, is online, has a healthy data plane, applied its target configuration and stayed so for two heartbeat intervals |
| `deliveries` | `array<object>` | Per-node tasks, by phase, then node name |
| `deliveries[].id` | string | Delivery ID |
| `deliveries[].nodeId` | string | Node ID |
| `deliveries[].nodeName` | string | Node name |
| `deliveries[].phase` | enum | `canary` / `rollout` |
| `deliveries[].state` | enum | `held`, `pending`, `running`, `succeeded`, `failed`, `cancelled` |
| `deliveries[].message` | string | Message |
| `deliveries[].errorCode` | string | Error code, such as `upgrade_cancelled`, `upgrade_expired`, `upgrade_node_removed` (node disabled or deleted), or a code the node reported; `""` without one |
| `deliveries[].deadlineAt` | string | Deadline of `pending` and `running` deliveries (30 minutes after release), `null` in other states |
| `deliveries[].finishedAt` | string | Finished, or `null` |

### L4 app object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | App ID |
| `clusterId` | uuid | Cluster ID |
| `clusterName` | string | Cluster name |
| `name` | string | Name |
| `protocol` | enum | `tcp` / `udp` |
| `port` | integer | Listening port (first port of a range) |
| `enabled` | boolean | Enabled; a disabled app is not shipped to nodes and has no DNS record |
| `acceptProxyProtocol` | boolean | The listener expects a PROXY protocol header |
| `proxyProtocolVersion` | integer | PROXY protocol version sent to the origins; 0 sends none |
| `portEnd` | integer | Last port of the range, `null` for a single port |
| `originPortMode` | enum | `fixed` / `same` |
| `certificateId` | uuid | Certificate for TLS termination, or `null` |
| `certificateName` | string | Certificate name, `null` without TLS |
| `tlsMinimumVersion` | enum | `1.2` / `1.3` |
| `origins` | `array<object>` | Origins `{ id, address, port, weight, backup }`, in the order saved; `port` is 0 with `originPortMode` `same` |
| `maxFails` | integer | Consecutive failures of the passive health check |
| `failTimeoutSeconds` | integer | Retry seconds of the passive health check |
| `connectTimeoutMs` | integer | Origin connect timeout (ms) |
| `idleTimeoutSeconds` | integer | Idle timeout (seconds) |
| `allowListIds` | `array<uuid>` | Allow lists |
| `blockListIds` | `array<uuid>` | Block lists |
| `maxConnections` | integer | Concurrency limit per node; 0 means none |
| `newConnectionsPerSecond` | integer | New connections per second limit per node; 0 means none |
| `cnamePrefix` | string | First label of the CNAME target (random for new apps, the ID for older ones) |
| `dnsTarget` | string | The CNAME clients connect to, `<cnamePrefix>.<cluster DNS domain>` (published while the app is enabled); `null` while the cluster's DNS is off |
| `dnsLines` | `array<object>` | Per DNS line `{ name, target }`: `<line>.<cnamePrefix>.<domain>` with line aliases, else `<line>.<domain>` |
| `dnsRetired` | `array<object>` | Replaced names that keep resolving until `expiresAt`, `{ name, expiresAt }` (with a DNS binding) |
| `createdAt` | datetime | Created |
| `updatedAt` | datetime | Updated |
