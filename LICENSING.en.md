# Licensing

License, permitted use, and commercial product boundaries of the open core.

## Open source principles and licensing

Edgeweir follows the design principle of **"no gates on the open core, a clear boundary for commercial extensions"**. We know that the worst things an infrastructure project can do are to change its terms later or to hide backdoors, so we state the following explicitly:

### 1. Real open source, no hidden gates

- **AGPL-3.0-only**: the console and edge node source code is fully open. Personal use, acceleration inside a company, and paid services to the public are all free to use, modify, and distribute, as long as they meet the license terms.
- **No node or scale limits**: we will never limit the number of nodes, sites, or bandwidth of the open-source edition.
- **No phone-home, no online activation locks**: the open core sends no telemetry to official servers and contains no hidden feature locks that need online activation to unlock.

### 2. A clear boundary between the open core and commercial extensions

- **What does the open-source edition include?** A single-operator CDN for personal use: one operator account, the full edge proxy, certificate automation, the 8-phase WAF, intelligent scheduling, logging and auditing, and the open API: enough for the full production needs of a self-built CDN. The open-source edition does not support multi-tenancy.
- **What does the commercial edition (Business) address?** It is built for IDCs and operators that sell services to their own customers: multi-tenancy (organizations, members, invitations, roles and permissions, organization isolation), customer self-service sign-up, plan purchases, 95th-percentile bandwidth and traffic billing and settlement, online reconciliation, and a multi-level reseller system. The commercial modules run independently and leave the open core untouched.

## License

| Repository | License |
| --- | --- |
| `edgeweir` (console) | AGPL-3.0-only |
| `edgeweir-node` (node) | AGPL-3.0-only |
| Third-party components | Their own licenses |
| GeoIP data bundled in node release images, [IPinfo Lite](https://ipinfo.io/lite) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), redistributed unmodified, not AGPL code; attribution: IP address data is powered by [IPinfo](https://ipinfo.io) |

## Product boundary

| Capability | Belongs to |
| --- | --- |
| The operator account (password, two-factor, passkeys), AccessKeys, service accounts, audit log | Open core |
| Console, node management, public API | Open core |
| Multi-tenancy: organizations, members, invitations, roles and permissions, organization isolation and per-organization quotas | Separate commercial operations product |
| Customer-facing portal, self-service sign-up and purchase, plans and billing, balances and finance, reselling and settlement | Separate commercial operations product |
| L2 origin aggregation nodes and Tiered Cache (with Topologies and latency-based parent selection), cache sharing within a group (consistent-hash sharding, cache index nodes), automatic node removal when a lease or server term expires, access log push to custom sinks and Logpush, Prometheus metrics, GeoIP hot reload, OIDC SSO, 103 Early Hints, Speculation-Rules, 0-RTT, Tunnels, edge compute with approval of tenant scripts, self-hosted authoritative DNS / GTM, XDP / eBPF | Separate commercial product |
| Official accounts, subscriptions, licensing, plugin distribution | Separate commercial services |

- "Personal use" and "single operator" describe the feature scope of the open-source edition, not a license restriction: as the AGPL permits, it may be used for any lawful purpose, including paid services for others.
- The separate commercial operations product and commercial services are official product plans. No product is currently available for purchase, and no feature has been delivered.
- The product boundary governs what the project officially develops and delivers. It does not prohibit the community from implementing similar features as the AGPL permits.
- Buying an open-source plugin does not remove the open-source rights the buyer holds under law.
- Resource protection, permissions, and operational quotas are not commercial feature locks.
- Separate commercial products do not change the rights of use of the core.

## Commercial code and the AGPL

- Independently authored code in future commercial products may be licensed under separate proprietary terms, stated explicitly on delivery.
- A private repository, a separate container, or a separate process does not by itself waive the AGPL. Copying core code, creating derivative or combined works, and using third-party dependencies remain subject to the applicable licenses.
- Integration method and code ownership must be verified before a closed-source plugin is released.
- This document grants no general plugin exception and adds no commercial dual license to the existing core.

## Contributions

- Contributions to the two open-source repositories are provided under AGPL-3.0-only.
- The existence of commercial products does not automatically grant the project a right to relicense contributions under proprietary terms.
- A future dual license, linking exception, or commercial reuse of code requires prior verification of copyright ownership, contributor authorization, and third-party licenses, and a separate explicit agreement.
