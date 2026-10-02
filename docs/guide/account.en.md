# Account and sign-in

The console's only account: creation, sign-in methods, account security, sessions, personal settings, and console navigation.

## Account

The console has one account, created by the setup wizard (`/setup`, **Create your account**).

| Item | Description |
| --- | --- |
| Setup fields | **Setup token** (the one-time token printed in the console log), **Name** (1–100 characters), **Email** (the sign-in email), **Password** (12–128 characters). For the steps, see [Quick start](first-site.en.md) |
| Other accounts | Sign-up is closed; the console has no user management and no way to add a second account |
| Name and email | The console offers no way to change them |
| Password | Changed in [Account security](#account-security); the web UI has no password recovery or reset. A forgotten password is reset on the server, see [Account recovery](#account-recovery) |
| API | AccessKeys (prefix `ewk_`) call `/api/v1` as this account; create them in [Settings](#settings) |

## Sign-in

Page: `/login`.

| Method | Description |
| --- | --- |
| Password | Enter **Email** and **Password**, then click **Sign in** |
| Two-factor authentication | With TOTP enabled, a correct password leads to **Two-factor authentication**: enter the 6-digit code, or click **Use a backup code** and enter a backup code. The step is valid for 10 minutes |
| Passkey | Click **Sign in with a passkey**; no two-factor step follows. Hidden in browsers without WebAuthn |

| Item | Description |
| --- | --- |
| Redirect | After sign-in, the console returns to the page opened before, otherwise to **Overview** |
| Sign-in rate limit | Sign-in, two-factor authentication, and password change: 3 attempts per 10 seconds per client IP, active in production (`NODE_ENV=production`). For how the client IP is determined, see [Trusted proxies and client IP](../deploy/networking.en.md#trusted-proxies-and-client-ip) |
| Audit | Successful (`auth.sign_in`, with the sign-in method) and failed (`auth.sign_in_failed`) sign-ins are written to the [audit log](system.en.md#audit-log) |

## Sessions

| Item | Description |
| --- | --- |
| Lifetime | 7 days; extended at most once every 24 hours while in use (better-auth defaults) |
| Sign out | User menu at the bottom of the sidebar → **Log out** |
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

## Settings

Page: user menu → **Settings** (`/settings`).

| Card | Content |
| --- | --- |
| **Preferences** | **Language** (简体中文 / English) and **Theme** (Light / Dark / System), stored in the current browser |
| **Access keys** | Create and revoke AccessKeys: **Name** and **Scope** (**Read only** / **Read and write**); the key is shown once. Read-only keys call GET procedures and `rules.validate` only. Keys are created only in a signed-in console; creating one with an AccessKey returns 403 `ACCESS_KEY_SESSION_REQUIRED` |

For using and revoking AccessKeys, see [Access logs and access keys](access-logs.en.md); for the request format, see [API and endpoints](../reference/api.en.md).

## Console navigation

**New site** at the top of the sidebar opens the new site form; while there is no node it is **Add node** and opens the add-node dialog. ⌘K / Ctrl+K opens the command menu: search for and open any page (**Security** and **Settings** included), or run **New site**, **Add node**, **Switch language**, or **Toggle dark mode**.

### Sidebar

| Group | Menu | Path | Content |
| --- | --- | --- | --- |
| — | **Overview** | `/overview` | See [Overview](#overview) |
| — | **Sites** | `/sites` | Site list and details; for enabling and disabling, see [Site enabling](system.en.md#site-enabling). The **Sites \| L4 apps** switch above the list leads to the L4 app list (`/l4`), see [Layer-4 forwarding](l4.en.md) |
| — | **Certificates** | `/certificates` | Certificates and DNS credentials; see [HTTPS and certificates](https.en.md) |
| — | **Purge & prefetch** | `/purge` | URL, directory, and site purges, URL prefetch, and tasks; see [Origins and cache](origins-and-cache.en.md) |
| **Access control** | **IP lists** | `/ip-lists` | Lists referenced by rules, and allow and block lists; see [Rules, IP lists, and GeoIP](rules.en.md) |
| **Access control** | **Bans** | `/bans` | Site bans and global bans; see [Bans](bans.en.md) |
| **Access control** | **Global rules** | `/rules` | Rules applied to every site; see [Rules, IP lists, and GeoIP](rules.en.md) |
| **Infrastructure** | **Clusters & nodes** | `/clusters` | Clusters, node groups, nodes, configuration canary, node upgrades, revisions, and the cluster's DNS binding and scheduling; see [Clusters and nodes](system.en.md#clusters-and-nodes) |
| **Infrastructure** | **Regions & probes** | `/regions` | Regions, regional probes, and probe settings; see [Regions](system.en.md#regions) and [Regional probes](scheduling.en.md#regional-probes) |
| **Infrastructure** | **DNS steering** | `/dns` | DNS provider accounts, each cluster's DNS binding, and mass removal protection; see [Configure DNS steering](dns-and-alerts.en.md#configure-dns-steering) |
| **System** | **Alerts** | `/alerts` | Alert channels, subscriptions, recent events, and alert rules; see [Alerts page](dns-and-alerts.en.md#alerts-page) |
| **System** | **Service accounts** | `/service-accounts` | Service accounts integrations use on `/api/v1`; see [Service accounts](system.en.md#service-accounts) |
| **System** | **Audit log** | `/audit` | See [Audit log](system.en.md#audit-log) |
| **System** | **System** | `/system` | See [System settings](system.en.md#system-settings) |

### User menu

The bottom of the sidebar shows the account's name and email; click it to open the user menu.

| Item | Description |
| --- | --- |
| **Security** | `/security`; see [Account security](#account-security) |
| **Settings** | `/settings`; see [Settings](#settings) |
| **Language** | 简体中文 / English |
| **Theme** | Light / Dark / System |
| **Log out** | Ends the current session and returns to the sign-in page |

### Overview

**Overview** (`/overview`) is the home page after sign-in.

| Block | Content |
| --- | --- |
| **Sites** | Number of sites; starred sites first, then the other sites by creation time, at most 5. Sites are starred in the **Sites** list or on the site page |
| **Nodes** | Online and total nodes; nodes that need attention first: **Offline**, **Apply failed**, **Data plane unhealthy**, **Behind**, **Pending**, **Disabled**, **In sync**. Shows **Add node** when there are no nodes |
| **Recent revisions** | The latest revisions across all clusters, with their reasons |
| **Recents** | Pages and sites recently opened in the current browser, at most 5 |
| **Analytics** | Traffic, ranges from 1 hour to 30 days (24 hours by default); the metric cards open breakdowns by site, node, and status code. **Top sites** and **Top nodes** show each item's cluster |

Nodes and recent revisions refresh every 10 seconds, analytics every minute.

### Other paths

| Path | Description |
| --- | --- |
| `/` | No page: redirects to `/setup` before setup, to `/overview` when signed in, otherwise to `/login` |
| `/login` | Sign-in |
| `/setup` | Setup wizard; redirects to `/login` once setup is done |

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| **Invalid code** | The two-factor code is wrong | Check the time on the authenticator device and retry, or use a backup code |
| **Verification expired, sign in again** | The two-factor step took longer than 10 minutes | Sign in again |
| **Too many requests, try again later** | Sign-in rate limit reached | Retry after 10 seconds |
| **Incorrect password** | **Current password** is wrong when changing the password or enabling or disabling two-factor authentication | Enter the current password again |
| A passkey no longer signs in | The console host name changed | Sign in with the password, delete the old passkey, and add it again |
| Forgotten password | The web UI has no password recovery | Reset the password on the server, see [Account recovery](#account-recovery) |
| Authenticator device and backup codes both lost | Two-factor authentication cannot be completed | Turn two-factor authentication off on the server, see [Account recovery](#account-recovery); enable it again after signing in |
| Two-factor authentication always fails after `BETTER_AUTH_SECRET` changed | TOTP secrets and backup codes are encrypted with the previous secret, which the new one cannot decrypt | Restore the previous `BETTER_AUTH_SECRET`; if it is lost, turn two-factor authentication off on the server (see [Account recovery](#account-recovery)) and enable it again after signing in |

### Account recovery

When nobody can sign in, run `recover.js` on the server that runs the console: it resets the password of the only account, turns two-factor authentication off, or both. The command does not go through the web UI; it reads the console container's environment and changes the database directly.

1. Run the command; drop the option you do not need:

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
