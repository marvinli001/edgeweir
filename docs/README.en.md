# Edgeweir open source

Self-hosted CDN, WAF and edge scheduling control plane for a single operator: console, API and edge nodes.

| Component | Delivery | Role |
| --- | --- | --- |
| Console | Image `ghcr.io/marvinli001/edgeweir` (linux/amd64, linux/arm64) | Web UI and `/api/v1` (:3000), node channel (:8443), pg-boss worker, `edgeweir-certd` |
| PostgreSQL 18 | External dependency | All state, job queue, configuration change broadcast |
| ClickHouse | Optional | Raw access logs and per-minute statistics |
| Edge node | [edgeweir-node](https://github.com/marvinli001/edgeweir-node): deb, rpm, binary archive, container image | Go agent syncs configuration over mTLS; OpenResty proxies, caches, fetches from origins and enforces protection |

## Documentation

| Group | Pages |
| --- | --- |
| Getting started | [Concepts](guide/concepts.en.md) · [Quick start](guide/first-site.en.md) |
| Deployment | [Deployment overview](deploy/README.en.md) · [Docker Compose](deploy/docker.en.md) · [BaoTa Panel and aaPanel](deploy/baota.en.md) · [deploy.sh reference](deploy/deploy-script.en.md) · [Railway](deploy/railway.en.md) · [Fly.io](deploy/fly.en.md) · [bunny.net Magic Containers](deploy/bunny.en.md) · [Render](deploy/render.en.md) · [Zeabur](deploy/zeabur.en.md) · [Ports, reverse proxy, and trusted proxies](deploy/networking.en.md) |
| Sites | [Overview](guide/overview.en.md) · [Site management](guide/site-management.en.md) · [Domains and unknown hosts](guide/domains.en.md) · [Origins and cache](guide/origins-and-cache.en.md) · [Tiered Cache](guide/tiered-cache.en.md) · [Image format conversion](guide/image-convert.en.md) · [Markdown for Agents](guide/markdown-agents.en.md) · [HTTPS and certificates](guide/https.en.md) · [Error pages](guide/error-pages.en.md) · [L4 forwarding](guide/l4.en.md) · [Usage protection](guide/usage-protection.en.md) · [Analytics and access logs](guide/access-logs.en.md) |
| Access control | [Rules, IP lists, and GeoIP](guide/rules.en.md) · [Access control](guide/access-control.en.md) · [Bans](guide/bans.en.md) · [Challenges and CC mitigation](guide/challenges.en.md) · [AI crawl control](guide/ai-crawl-control.en.md) · [OWASP CRS managed rules](guide/waf.en.md) · [Attacks and automatic mitigation](guide/attack-dashboard.en.md) |
| Infrastructure | [Clusters and nodes](guide/clusters.en.md) · [Regional probes and scheduling](guide/scheduling.en.md) · [DNS steering](guide/dns.en.md) |
| System | [Account and sign-in](guide/account.en.md) · [Alerts](guide/alerts.en.md) · [System settings and audit](guide/system.en.md) · [Node extensions](guide/extensions.en.md) |
| Nodes | [Node overview](node/README.en.md) · [Adding nodes](deploy/nodes.en.md) · [Node configuration](node/configuration.en.md) · [Node upgrades](guide/node-upgrades.en.md) · [Node logs](guide/node-logs.en.md) · [Node operations](node/operations.en.md) · [Node troubleshooting](node/troubleshooting.en.md) |
| Operations | [Versions and upgrades](deploy/upgrade.en.md) · [Downgrade](deploy/downgrade.en.md) · [Backup and recovery](deploy/backup.en.md) · [Maintenance](deploy/maintenance.en.md) · [Troubleshooting](deploy/troubleshooting.en.md) |
| Reference | [API overview](reference/api.en.md) · [API: Sites](reference/api/sites.en.md) · [API: Access control](reference/api/security.en.md) · [API: Certificates](reference/api/certificates.en.md) · [API: Clusters and nodes](reference/api/clusters.en.md) · [API: DNS and scheduling](reference/api/dns.en.md) · [API: Overview, analytics and alerts](reference/api/monitoring.en.md) · [API: System and account](reference/api/system.en.md) · [Environment variables](reference/environment.en.md) · [Command line](reference/cli.en.md) · [Error codes](reference/errors.en.md) · [Node extension contract](reference/extensions.en.md) |
| Project | [Architecture](../ARCHITECTURE.en.md) · [Security policy](../SECURITY.en.md) · [Contributing](../CONTRIBUTING.en.md) · [Licensing](../LICENSING.en.md) |
