# Concepts

Control plane objects, how they relate, how configuration reaches the nodes, and the identities that access the console.

## Objects

| Concept | Definition | See |
| --- | --- | --- |
| Site | A set of domains with the origins, cache, HTTPS, rules and protection settings they share. It belongs to one cluster and cannot move to another after creation | [Create a site](first-site.en.md#3-create-a-site), [Site management](site-management.en.md) |
| Domain | A request Host the site matches: exact, wildcard (`*.a.com`), suffix (`.a.com`) or regex (`~`). A domain in one form belongs to one site only | [Domains](domains.en.md) |
| Origin | An address, port and protocol the site fetches from (HTTP, HTTPS or S3-compatible object storage) | [Origins and cache](origins-and-cache.en.md#configure-origins) |
| Origin pool | All origins of a site, with load balancing, health checks, timeouts and keepalive; one per site | [Pool settings](origins-and-cache.en.md#pool-settings) |
| Origin group | A group label on an origin, empty for the default group; rules can send requests to another group | [Origin groups](origins-and-cache.en.md#origin-groups) |
| L4 app | Forwards TCP connections or UDP sessions on one port of every node of a cluster to origins | [L4 forwarding](l4.en.md) |
| Certificate | An uploaded or ACME-issued TLS certificate that sites' HTTPS settings reference | [HTTPS and certificates](https.en.md) |
| Cluster | A set of nodes and the sites and L4 apps assigned to them. Listening ports, the revision sequence, the DNS binding and scheduling rules are per cluster | [Clusters](clusters.en.md#clusters) |
| Node group | A group of nodes inside a cluster, optionally with a region. DNS lines, backup node groups, the configuration canary and node upgrades work on node groups; every cluster has a default node group `default` | [Node groups](clusters.en.md#node-groups) |
| Node | A host running edgeweir-node (agent and OpenResty). It enrolls with a one-time install command and then connects to the node channel over mTLS with its client certificate. It is online with a heartbeat in the last 45 seconds | [Nodes](clusters.en.md#nodes), [Enroll nodes](../deploy/nodes.en.md) |
| Region | A platform-wide location label (name and code) referenced by node groups and regional probes | [Regions](clusters.en.md#regions) |
| Regional probe | A probing process running in a region that probes every node's scheduling addresses from there; a node can also act as one | [Regional probes](scheduling.en.md#regional-probes) |
| Revision | A cluster's complete node configuration (NodeConfig) with a revision number increasing within the cluster and a content hash. A change to node configuration publishes a new revision in the same transaction; identical content publishes none | [Revisions](clusters.en.md#revisions) |
| Snapshot and diff | A node asks for configuration with the revision it has applied; the node channel returns a full snapshot or a diff against that revision. The node checks the hash, keeps it as last-known-good and then applies it | [Configuration delivery](#configuration-delivery) |
| Configuration canary | A per-cluster release policy: a new revision goes to canary node groups first, reaches every node after the observation window passes, and rolls back otherwise | [Configuration canary](clusters.en.md#configuration-canary) |
| Node task | Purges (URL, directory, Host, Cache-Tag, whole site) and preloads (URL, sitemap): no revision, sent as tasks to the cluster's enabled nodes | [Origins and cache](origins-and-cache.en.md) |
| DNS binding | A cluster's DNS steering settings: mode, provider account, cluster domain, TTL and lines | [DNS steering](dns.en.md) |
| DNS revision | A snapshot of a cluster's DNS binding and its records, separate from configuration revisions | [DNS revisions and rollback](dns.en.md#dns-revisions-and-rollback) |
| Scheduling rule | A rule that changes a cluster's DNS records by node metrics or probe results | [Scheduling rules](scheduling.en.md#scheduling-rules) |
| Account | The console's only operator account, created by the setup wizard | [Account and sign-in](account.en.md) |
| AccessKey | A key that calls `/api/v1` as the account, starting with `ewk_`; scope read-only or read-write | [Personal settings](account.en.md#personal-settings) |
| Service account | A separate identity for integrations calling `/api/v1`; it cannot sign in. Keys start with `ews_` and call only the procedures their scopes allow | [Service accounts](system.en.md#service-accounts) |
| Audit log | Records of management actions: actor, action, target, origin and metadata; the console's own changes commit with their audit entries in one transaction | [Audit log](system.en.md#audit-log) |

## Relationships

| Object | Belongs to | Count and constraints |
| --- | --- | --- |
| Node group | Cluster | At least one per cluster (the default node group); names are unique within the cluster |
| Node | Node group | One node group per node; it moves only between node groups of its cluster |
| Node group → region | Region | Zero or one region; deleting the region clears it |
| Regional probe | Region | One region; a region with probes cannot be deleted |
| Site | Cluster | At most 512 enabled sites published per cluster |
| L4 app | Cluster | At most 256 per cluster; ports come from the cluster's port pools |
| Domain | Site | Zero or more per site |
| Origin pool | Site | One per site |
| Origin | Origin pool | Each origin may carry an origin group label |
| Certificate | Platform | Several sites may reference one certificate; a referenced certificate cannot be deleted |
| Revision | Cluster | The latest 200 are kept per cluster |
| DNS binding | Cluster | One per cluster; with mode Not managed nothing is written to DNS |
| DNS revision | Cluster | The latest 200 are kept per cluster |
| Scheduling rule | Cluster | Acts on all lines of the cluster's DNS binding or one of them |
| AccessKey | Account | Created only in a signed-in console |
| Service account key | Service account | Zero or more per service account; deleting the service account invalidates all |

## Configuration delivery

1. The console writes the business tables in one transaction, compiles the cluster's NodeConfig and computes its content hash; when it differs from the previous revision it writes a new revision and notifies every console instance.
2. The console notifies the cluster's nodes over their `WatchConfig` stream.
3. The node calls `GetConfig` with its applied revision, receives a snapshot or a diff, checks the hash, keeps it as last-known-good and applies it to OpenResty.
4. The node reports its applied revision and heartbeat with `ReportStatus`; the console shows **Applied revision**, sites' rollout state and the DNS address set from it.

| Item | Behavior |
| --- | --- |
| Target revision | Without a canary, the cluster's latest revision; during a canary, the candidate revision for canary nodes and the stable revision for the others |
| Node capabilities | When the configuration needs a capability a node lacks, that node shows **Needs upgrade** and keeps its configuration, see [Revisions](clusters.en.md#revisions) |
| Console unreachable | Nodes keep serving with the last configuration they applied |
| Rollback | Publishes a new revision with the chosen revision's content and keeps the history, see [Revisions](clusters.en.md#revisions) |

The node channel protocol and authentication: [Architecture](../../ARCHITECTURE.md).

## Access identities

| Identity | Credential | Entry | Permissions |
| --- | --- | --- | --- |
| Account (session) | Session cookie and CSRF header | Web UI, `/rpc` | Everything |
| AccessKey | `x-api-key: ewk_…` | `/api/v1` | Read-write: as the session, except creating or changing keys; read-only: GET procedures and `rules.validate` |
| Service account | `x-api-key: ews_…` | `/api/v1` | The service account procedures its scopes allow |
| Node | Install token `ewt_…` (single use), then a client certificate | Node channel (default `:8443`) | Node RPCs |
| Regional probe | Enrollment token `ewp_…` (single use), then a client certificate | Node channel | Probe RPCs only |

Tokens are stored as SHA-256 only. Audit log actor types: **User**, **Access key**, **Service account**, **Node**, **Probe** and **System**. Endpoints and request formats: [API and endpoints](../reference/api.en.md).
