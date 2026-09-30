# Organizations, members, and account security

Organizations and roles, invitations, the organization two-factor policy, account security settings, and console navigation.

## Organizations

An organization is the boundary for tenant resources and permissions. Sites (with their domains, origins, caching, HTTPS, rules, and log settings), certificates, DNS credentials, and IP lists belong to one organization; members reach only the resources of their current organization.

| Item | Behavior |
| --- | --- |
| Creation | The setup wizard creates the first organization; platform administrators create the others in **Admin → Organizations & users**. Users cannot create organizations |
| Deletion | Not supported |
| Several organizations | A user can belong to several organizations. With two or more, the top of the sidebar shows an organization switch (**Switch organization**) |
| Current organization | Stored in the session; membership is rechecked on every request, falling back to the earliest joined organization |
| Default cluster | New sites of the organization land on its default cluster, or on the oldest cluster when none is set. Platform administrators set it; organization members cannot choose a cluster |
| Domains | A registrable domain belongs to one organization once its ownership is verified; see [Verify domain ownership](dns-and-alerts.en.md#verify-domain-ownership) |

For the cross-organization rights of platform administrators, see [Platform administration](admin.en.md#platform-administrators).

## Roles

Organization roles: **Owner** (`owner`), **Admin** (`admin`), and **Member** (`member`). The organization role **Admin** is unrelated to [platform administrators](admin.en.md#platform-administrators).

| Capability | Owner | Admin | Member |
| --- | --- | --- | --- |
| Sites, domain ownership, certificates and DNS credentials, IP lists, purge & prefetch, access logs, alert subscriptions | ✓ | ✓ | ✓ |
| Enable / disable sites | ✓ | ✓ | — |
| View bans | ✓ | ✓ | ✓ |
| Ban and unban addresses of sites | ✓ | ✓ | — |
| Create AccessKeys (calling `/api/v1` as their creator) | ✓ | ✓ | ✓ |
| Open **Members**: members and pending invitations | ✓ | ✓ | — |
| Invite, change the role of, and remove **Admin** and **Member** | ✓ | ✓ | — |
| Grant, change, or remove **Owner**; see and create owner invitations | ✓ | — | — |
| **Organization policy**: **Require two-factor authentication** | ✓ | ✓ | — |

| Constraint | Description |
| --- | --- |
| Last owner | An organization keeps at least one owner; removing or demoting the last owner is refused |
| Self | The role picker and removal are unavailable on one's own row in **Members** |
| Platform administrators | Treated as owners in the organizations they belong to |

For AccessKey scopes and revocation, see [Access logs and AccessKey](access-logs.en.md).

## Invitations and member management

Page: **Members** (`/members`).

| Action | Description |
| --- | --- |
| **Invite member** | Enter **E-mail** and **Role**, then click **Create invitation link**. The console shows the **Invitation link** `https://<console>/invite/<invitation ID>` and sends no email |
| **Pending invitations** | Lists unexpired invitations; copy the link or **Cancel** |
| Role | Change it in the **Role** dropdown of the member's row |
| **Remove** | Removes the member from the organization; the account stays |

| Invitation rule | Description |
| --- | --- |
| Lifetime | 7 days |
| Replacement | A new invitation for the same email cancels the pending one |
| Credential | The invitation ID in the link is the credential; while the invited email has no account, whoever holds the link can create that account and join |
| Existing account | Sign in as the invited email to accept (**Sign in to accept** → **Accept invitation**) |
| New account | Enter **Name** and **Password** (12–128 characters) on the invitation page; the account is created on acceptance |
| Already a member | Invitations for that email are refused |

Platform administrators can also add existing users to, or invite into, any organization from **Admin → Organizations & users**; see [Platform administration](admin.en.md#organizations-and-users).

## Organization two-factor policy

Switch: **Members → Organization policy → Require two-factor authentication** (owners, admins); platform administrators can also set it when editing the organization in **Admin → Organizations & users**.

| Item | Behavior |
| --- | --- |
| Applies when | The organization has the policy on and the member has not enabled two-factor authentication (TOTP). Passkeys do not satisfy it |
| Console | The member is held on **Account security**, which shows **Your organization requires two-factor authentication before you continue** |
| API | The member's calls on organization resources, including `/api/v1` calls with their AccessKeys, return `TWO_FACTOR_REQUIRED` |
| Exemption | Platform administrators are not bound by the organization policy |
| Status | The **2FA** column in **Members** shows **On** / **Off** |

## Site enabling and platform suspension

A site has two independent states; it is shipped to nodes only when both allow it:

| State | Changed by | Where |
| --- | --- | --- |
| Enabled / disabled | Organization owners and admins; platform administrators | **Disable** / **Enable** under **Overview → Status** of the site (confirmed) |
| Suspended | Platform administrators | **Admin → Sites**, see [Administration](admin.en.md#sites) |

| Item | Behavior |
| --- | --- |
| List | The **Status** column of **Sites** shows **Active**, **Disabled**, **Suspended** |
| Nodes | A disabled or suspended site is not shipped; nodes answer 404 for its domains (`X-Edgeweir-Error: unknown-host`) |
| DNS | Records stay, see [Generated records](dns-and-alerts.en.md#generated-records) |
| Certificates | Renewal continues; HTTP-01 challenges are answered |
| Purge & prefetch | Return `SITE_DISABLED` / `SITE_SUSPENDED` |
| Suspension notice | The site page shows **The platform suspended this site: {reason}** (Billing, Abuse, Security, Other); members cannot lift it, and enabling or disabling does not affect it |
| Revisions and audit | A change publishes a revision and writes an audit entry; an unchanged state does neither |

## Technical limits

Limits are resource protection the operator sets; by default nothing is limited. Platform administrators set them under **Admin → Organizations and users → Organizations → Limits**; an empty field means no limit (only the global hard limits apply).

| Limit | Counts |
| --- | --- |
| Sites | The organization's sites |
| Domains | Domains of all of its sites (wildcards and unverified domains included) |
| Certificates | The organization's certificates (uploaded and ACME) |
| IP list entries | Entries of all of its IP lists |
| Purge tasks per minute | Purge and prefetch tasks submitted in the last minute; 10 when empty |
| Purge targets per hour | URLs, prefixes and sites submitted in the last hour; 2000 when empty |
| Members | Organization members; checked on invitation and on joining |
| Bans | Active manual bans of the organization's sites; automatic bans do not count, see [Bans](bans.en.md) |

| Item | Behavior |
| --- | --- |
| Exceeded | Creation is refused with `ORG_LIMIT_EXCEEDED` (resource, limit, current use); purge rates without an organization limit still return `CACHE_TASK_RATE_LIMITED` |
| Concurrency | Creation locks the organization before counting in the same transaction; concurrent creations cannot pass a limit |
| Lowering | Allowed below current use; existing resources stay, new ones are refused |
| Platform administrators | Creating resources in the organization is limited the same way, except purge rates |
| Viewing | The **Limits** card on **Settings** lists the limits that are set with their use (all members) |
| Audit | `organization.limits_update` with the values before and after |

## Account security

Page: **Account security** (`/security`), available to every user. Accounts are created by the setup wizard, by platform administrators, or through invitations; self sign-up is closed. The console has no password recovery or reset.

### Password

| Item | Description |
| --- | --- |
| Change | Enter **Current password**, **New password**, and **Confirm new password**, then click **Change password** |
| Length | 12–128 characters |
| Other sessions | Signed out after the change |

### Two-factor authentication (TOTP)

1. Under **Two-factor authentication (TOTP)**, enter **Current password** and click **Enable**.
2. Scan the QR code with an authenticator, or enter the **Secret key** manually.
3. Enter the 6-digit **Code** and click **Verify**.
4. Store the **Backup codes** (shown once).

| Item | Description |
| --- | --- |
| TOTP parameters | 6 digits, 30 seconds, issuer `Edgeweir` |
| Backup codes | 10 codes, format `xxxxx-xxxxx`, each usable once |
| Sign-in | After the password, **Two-factor authentication** asks for a code, or **Use a backup code** |
| New backup codes | Disable and enable two-factor authentication again |
| Disable | Enter **Current password** and click **Disable** |

### Passkeys

| Item | Description |
| --- | --- |
| Add | Enter a **Name** (optional, at most 64 characters), click **Add passkey**, and follow the browser prompt. The button is disabled in browsers without WebAuthn |
| Delete | Delete from the list, with confirmation |
| Sign-in | **Sign in with a passkey** on the sign-in page; no two-factor step follows |
| Binding | Passkeys are bound to the host name of `EDGEWEIR_PUBLIC_URL`; after the console host name changes, registered passkeys stop working |

### Sessions

| Item | Description |
| --- | --- |
| Sign out | User menu at the bottom of the sidebar → **Log out** |
| Lifetime | 7 days; extended at most once every 24 hours while in use (better-auth defaults) |
| Sign-in rate limit | Sign-in and password change: 3 attempts per 10 seconds per client IP, active in production (`NODE_ENV=production`). For how the client IP is determined, see [Trusted proxies and client IP](../deploy/networking.en.md#trusted-proxies-and-client-ip) |
| Disabled account | Disabling an account deletes all its sessions; its AccessKey calls are refused while it stays disabled |

Sign-ins (including failures), password changes, two-factor enable and disable, and passkey add and delete are written to the [audit log](admin.en.md#audit-log).

## Console navigation

Every user works in the console; platform administrators also have the Admin area, see [Platform administration](admin.en.md#console-and-admin-switch).

| Menu | Path | Content | Visible to |
| --- | --- | --- | --- |
| **Overview** | `/overview` | Traffic analytics, top sites, recents | All |
| **Certificates** | `/certificates` | Certificates and DNS credentials; see [HTTPS and certificates](https.en.md) | All |
| **Sites** | `/sites` | Site list and details | All |
| **Alerts** | `/alerts` | Alert subscriptions and recent events; see [Domains, DNS, and alerts](dns-and-alerts.en.md) | All |
| **IP lists** | `/ip-lists` | The organization's IP lists; see [Rules, IP lists, and GeoIP](rules.en.md) | All |
| **Bans** | `/bans` | Bans of the organization's sites; see [Bans](bans.en.md) | All (banning and unbanning: owners, admins) |
| **Purge & prefetch** | `/purge` | URL, directory, and site purges, URL prefetch, and tasks; see [Origins and cache](origins-and-cache.en.md) | All |
| **Members** | `/members` | Members, invitations, organization policy | Owners, admins |
| **Security** | `/security` | Password, two-factor authentication, passkeys | All |
| **Settings** | `/settings` | Preferences (language, theme), access keys | All |

| Other path | Description |
| --- | --- |
| `/` | No page: redirects to `/setup` before setup, to `/overview` when signed in, otherwise to `/login` |
| `/login` | Sign-in |
| `/setup` | Setup wizard; redirects to `/login` once setup is done |
| `/invite/<invitation ID>` | Invitation page; opens without signing in |

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| **Organization owners and admins only** | A member called member management | An owner or admin performs the action |
| **Only organization owners can manage owners** | An admin granted, changed, or removed an owner | An owner performs the action |
| **An organization needs at least one owner** | Removing or demoting the last owner | Make another member an owner first |
| **Already a member: …** | The invited or added email is already in the organization | No invitation needed |
| **Invitation not found or expired** | Link older than 7 days, or cancelled, replaced, or accepted | Invite again |
| **Sign in as … to accept this invitation** | The signed-in account is not the invited email | Sign out and sign in as the invited email |
| **This account is disabled** | A platform administrator disabled the account | A platform administrator clicks **Enable account** |
| **Your organization requires two-factor authentication** | The organization policy requires TOTP | Enable two-factor authentication on **Account security** |
| **Verification expired, sign in again** | The two-factor step timed out | Sign in again |
| **Too many requests, try again later** | Sign-in rate limit reached | Retry after 10 seconds |
