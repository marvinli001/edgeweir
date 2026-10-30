# Account and sign-in

The console's only operator account: setup, sign-in, sessions, account security, personal settings, console navigation and account recovery.

## Account

The console has one account, created by the setup wizard (`/setup`, **Create your account**).

| Item | Description |
| --- | --- |
| Setup fields | **Setup token** (the one-time token printed in the console log), **Name** (1–100 characters), **Email** (the sign-in email), **Password** (12–128 characters). For the steps, see [Quick start](first-site.en.md) |
| Other accounts | Sign-up is closed; the console has no user management and no way to add a second account. The view-only demo account is switched in [System settings → Demo account](system.en.md#demo-account) and is not a second operator account |
| Name and email | The console offers no way to change them |
| Password | Changed in [Account security](#account-security); the web UI has no password recovery or reset. A forgotten password is reset on the server, see [Account recovery](#account-recovery) |
| API | AccessKeys (prefix `ewk_`) call `/api/v1` as this account; create them in [Personal settings](#personal-settings) |

## Sign-in

Page: `/login`.

| Method | Description |
| --- | --- |
| Password | Enter **Email** and **Password**, then click **Sign in** |
| Two-factor authentication | With TOTP enabled, a correct password leads to **Two-factor authentication**: enter the 6-digit code, or click **Use a backup code** and enter a backup code (**Use the authenticator** switches back, **Back to sign in** returns to the first step). The step is valid for 10 minutes; 5 wrong codes in one step require signing in again, and 10 failed verifications in a row lock two-factor authentication for 15 minutes |
| Passkey | Click **Sign in with a passkey**; no two-factor step follows. Hidden in browsers without WebAuthn |
| Demo account | With the [demo account](system.en.md#demo-account) on, **Sign in to the demo** appears |

| Item | Description |
| --- | --- |
| Redirect | After sign-in, the console returns to the page opened before, otherwise to **Overview** |
| Sign-in rate limit | Sign-in, two-factor authentication (enabling and disabling it under **Security** included), and password change: 3 attempts per 10 seconds per client IP, active in production (`NODE_ENV=production`). For how the client IP is determined, see [Trusted proxies and client IP](../deploy/networking.en.md#trusted-proxies-and-client-ip) |
| Login IP allow list | Once set, only addresses on the list may sign in and use sessions, see [Login IP allow list](system.en.md#login-ip-allow-list) |
| Audit | Successful (`auth.sign_in`, with the sign-in method) and failed (`auth.sign_in_failed`) sign-ins are written to the [audit log](system.en.md#audit-log) |

## Sessions

| Item | Description |
| --- | --- |
| Lifetime | 7 days; extended at most once every 24 hours while in use (better-auth defaults) |
| Sign out | The [user menu](#user-menu) in the top bar → **Log out** |
| Other devices | The console does not list sessions; changing the password signs out the sessions on other devices, and [account recovery](#account-recovery) signs out all sessions |

## Account security

Page: user menu → **Security** (`/security`, titled **Account security**).

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
| Status | **On** / **Off** next to the card title |
| TOTP parameters | 6 digits, 30 seconds, issuer `Edgeweir` |
| Backup codes | 10 codes, format `xxxxx-xxxxx`, each usable once |
| New backup codes | Disable and enable two-factor authentication again |
| Disable | Enter **Current password** and click **Disable** |

### Passkeys

| Item | Description |
| --- | --- |
| Add | Enter a **Name** (optional, at most 64 characters), click **Add passkey**, and follow the browser prompt. The button is disabled in browsers without WebAuthn |
| Delete | Delete from the list, with confirmation |
| Binding | Passkeys are bound to the host name of `EDGEWEIR_PUBLIC_URL`; after the console host name changes, registered passkeys stop working |

Password changes, two-factor enable and disable, and passkey add and delete are written to the [audit log](system.en.md#audit-log) (`account.*`).

## Personal settings

Page: user menu → **Personal settings** (`/settings`).

| Card | Content |
| --- | --- |
| **Preferences** | **Language** (简体中文 / English) and **Theme** (Light / Dark / System), stored in the current browser |
| **Access keys** | Create, edit and revoke AccessKeys, see the tables below |

| AccessKey field | Values | Description |
| --- | --- | --- |
| **Name** | 1–64 characters | Changeable later under **Edit key** |
| **Scope** | **Read only** / **Read and write**, default read and write | Read-only keys call GET procedures and `rules.validate` only; fixed after creation |
| **Requests per minute** | 1–100000, default 600; empty for no limit | Above it `/api/v1` returns 429 `API_KEY_RATE_LIMITED` ("Too many requests with this access key; try again in N s"); changeable under **Edit key** |

| Item | Description |
| --- | --- |
| Key | Starts with `ewk_`, shown once at creation |
| List | Each row shows the name, scope, requests per minute ("N/min" or "No rate limit"), **Revoked** and **Last used** |
| Session required | Created and edited only in a signed-in console; calls with an AccessKey return 403 `ACCESS_KEY_SESSION_REQUIRED` ("Sign in to create or change an access key") |
| Audit | `api_key.create`, `api_key.update`, `api_key.revoke` |

Request header, scopes and rate limits: [API overview](../reference/api.en.md#accesskey).

## Console navigation

### Sidebar

**New site** at the top of the sidebar opens the new-site form; without any node it is **Add node** and opens the add-node dialog. **Collapse sidebar** at the bottom folds the sidebar into an icon rail.

| Group | Item | Path | Content |
| --- | --- | --- | --- |
| **Sites** | **Overview** | `/overview` | The home page after sign-in, see [Overview](overview.en.md); shows the number of [Needs attention](clusters.en.md#needs-attention) items beside it |
| **Sites** | **Sites** | `/sites` | Site list and details, see [Site management](site-management.en.md). The **Sites \| L4 apps** switch above the list moves to the L4 app list (`/l4`), see [L4 forwarding](l4.en.md) |
| **Sites** | **Certificates** | `/certificates` | Certificates and DNS credentials, see [HTTPS and certificates](https.en.md) |
| **Sites** | **Purge & prefetch** | `/purge` | URL, directory and whole-site purges, URL prefetch and tasks, see [Origins and cache](origins-and-cache.en.md) |
| **Access control** | **Global rules** | `/rules` | Rules for every site, see [Rules, IP lists, and GeoIP](rules.en.md) |
| **Access control** | **IP lists & bans** | `/ip-lists`, `/bans`, `/greylist` | The **IP lists \| Bans \| Greylist** switch at the top moves between the three lists: IP lists in [Rules, IP lists, and GeoIP](rules.en.md), bans and the greylist in [Bans](bans.en.md). `/bans?site=<site ID>` shows one site's bans |
| **Access control** | **Protection settings** | `/protection` | Global Under Attack, ban settings, CC template, connection limits and GeoIP databases, see [Protection settings](system.en.md#protection-settings) |
| **Infrastructure** | **Clusters & nodes** | `/clusters` | Clusters, node groups, nodes, revisions, configuration canary, node upgrades, the cluster's DNS binding and scheduling, see [Clusters and nodes](clusters.en.md). **Clusters \| Regions** moves to regions (`/clusters?view=regions`), see [Regions](clusters.en.md#regions) |
| **Infrastructure** | **DNS steering** | `/dns` | DNS provider accounts, cluster bindings and mass removal protection, see [DNS steering](dns.en.md) |
| **System** | **Alerts** | `/alerts` | Alert channels, SMTP, subscriptions, recent alerts and alert rules, see [Alerts](alerts.en.md) |
| **System** | **Audit log** | `/audit` | See [Audit log](system.en.md#audit-log) |
| **System** | **System settings** | `/system` | Tabs **General**, **Monitoring** (`?tab=probes`, see [Regional probes](scheduling.en.md#regional-probes)) and **Service accounts** (`?tab=service-accounts`, see [Service accounts](system.en.md#service-accounts)), see [System settings](system.en.md#system-settings) |

A click anywhere on a row or card of a list opens it; rows that link to a page open in a new tab with a middle click or ⌘ / Ctrl+click. A row's other actions sit under **⋯** at its end. At phone width, **Open menu** in the top bar opens the sidebar as a drawer.

### Top bar

| Element | Description |
| --- | --- |
| Edgeweir logo | Opens **Overview** |
| Search field | "Search or run a command…", opens the [command menu](#command-menu) |
| **Language** | 简体中文 / English |
| Theme toggle | Light / dark |
| **Alerts** | Opens `/alerts`; with items needing attention it carries a red dot and reads "Needs attention: N" on hover |
| User menu | Avatar, name and role (**Administrator**; **View-only demo** for the demo account); a click opens the [user menu](#user-menu) |

### User menu

| Item | Description |
| --- | --- |
| Header | Name and email (**View-only demo** for the demo account) |
| **Security** | `/security`, see [Account security](#account-security) |
| **Personal settings** | `/settings`, see [Personal settings](#personal-settings) |
| **Language** | 简体中文 / English |
| **Theme** | Light / Dark / System |
| **Log out** | Ends the current session and returns to the sign-in page |

### Command menu

⌘K / Ctrl+K or the search field in the top bar opens the command menu; arrow keys select, Enter runs, Esc closes.

| Group | Behavior |
| --- | --- |
| **Sites** | Type a site name or domain to search sites, Enter opens one; with nothing typed, starred and recently visited sites are listed |
| **Site actions** | The first 3 matching sites each get "Under Attack: (site)" (toggles the site's Under Attack after a confirmation) and "Purge cache: (site)" (creates a whole-site purge task after a confirmation) |
| **Tags** | Matching tags "Tag: (tag)", at most 4, open the site list filtered by the tag |
| **Navigation** | Opens any page, including **L4 apps**, **Security**, **Personal settings**, the **Monitoring** tab of the system settings, and **Regions** and **Service accounts** on the pages they live on |
| **Actions** | **New site**, **Add node**, **Request certificate** (opens the request dialog), **Ban an IP…** (opens the ban dialog, with the site filled in on a site's pages), **Purge URLs…** (opens **Purge & prefetch**, with the site filled in on a site's pages), **Global Under Attack** (toggles it after a confirmation), **Switch language**, **Toggle dark mode** |

### Other paths

| Path | Description |
| --- | --- |
| `/` | No page: redirects to `/setup` before setup, to `/overview` when signed in, otherwise to `/login` |
| `/login` | Sign-in |
| `/setup` | Setup wizard; on completion it signs in and opens `/clusters?enroll=true` (the add-node dialog), or `/login` when that sign-in fails; after setup the path redirects to `/login` |
| `/regions` | Redirects to `/clusters?view=regions`; `/regions?tab=probes` to `/system?tab=probes` |
| `/service-accounts` | Redirects to `/system?tab=service-accounts` |
| `/admin/<page>` | Old paths, redirected to the page of the same name (`/admin/settings` to `/system`); unknown pages to `/overview` |
| Anything else | A not-found page inside the console |

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| **Invalid code** | The two-factor code is wrong | Check the time on the authenticator device and retry, or use a backup code |
| **Verification expired, sign in again** | The two-factor step took longer than 10 minutes | Sign in again |
| **Too many requests; try again later** | Sign-in rate limit reached; or 5 wrong codes in one two-factor step; or 10 failed verifications in a row, which lock two-factor authentication for 15 minutes | After the rate limit, retry after 10 seconds; after 5 wrong codes, sign in again; when locked, retry after 15 minutes |
| **This IP is not on the login allow list** | The current address is outside the [login IP allow list](system.en.md#login-ip-allow-list) | Sign in from a network on the list; if the list no longer holds any of your addresses, clear it on the server, see [Account recovery](#account-recovery) |
| **Incorrect password** | **Current password** is wrong when changing the password or enabling or disabling two-factor authentication | Enter the current password again |
| A passkey no longer signs in | The console host name changed | Sign in with the password, delete the old passkey, and add it again |
| Forgotten password | The web UI has no password recovery | Reset the password on the server, see [Account recovery](#account-recovery) |
| Authenticator device and backup codes both lost | Two-factor authentication cannot be completed | Turn two-factor authentication off on the server, see [Account recovery](#account-recovery); enable it again after signing in |
| Two-factor authentication always fails after `BETTER_AUTH_SECRET` changed | TOTP secrets and backup codes are encrypted with the previous secret, which the new one cannot decrypt | Restore the previous `BETTER_AUTH_SECRET`; if it is lost, turn two-factor authentication off on the server (see [Account recovery](#account-recovery)) and enable it again after signing in |

### Account recovery

When nobody can sign in, run `recover.js` on the server that runs the console: it resets the password of the only account, turns two-factor authentication off, clears the [login IP allow list](system.en.md#login-ip-allow-list), or several of these at once. The command does not go through the web UI; it reads the console container's environment and changes the database directly.

1. Run the command with the options you need (add `--clear-login-allowlist` to clear the allow list):

   ```bash
   docker compose exec console node dist/server/recover.js --reset-password --disable-two-factor
   ```

   On 宝塔 / aaPanel deployments the container is named `edgeweir-console`:

   ```bash
   docker exec -it edgeweir-console node dist/server/recover.js --reset-password --disable-two-factor
   ```

2. The command prints the account's name and email. With `--reset-password`, enter the new password twice when prompted (12–128 characters); it is not shown while typing.
3. Once the command prints what it changed, sign in with the account email, using the new password if you reset it.
4. If two-factor authentication was turned off, enable it again in [Account security](#account-security) and keep the new backup codes.

| Item | Description |
| --- | --- |
| Sessions | All sessions of the account are signed out; sign-ins waiting for their two-factor code expire |
| Unchanged | Name, email, passkeys, and AccessKeys. If someone else may have used the account, review them after signing in and delete passkeys and AccessKeys you do not recognize |
| Audit | Written to the [audit log](system.en.md#audit-log): `account.recover`, actor **System** (`recover`) |

For the options, reading the password from a file, the output, and exit codes, see [Command line](../reference/cli.en.md#account-recovery).
