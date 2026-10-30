# Versions and upgrades

Console image versions and channels, version pinning, signature verification, upgrade steps per deployment, startup migrations, and node compatibility.

## Versioning

| Item | Rule |
| --- | --- |
| Image | `ghcr.io/marvinli001/edgeweir`, linux/amd64 and linux/arm64, public |
| Tag | `<YYYYMMDD>-<commit>`: UTC commit date and the first 7 characters of the commit ID, e.g. `20260929-a1b2c3d`; the same commit always gets the same tag (`scripts/image-version.sh`). No semantic version numbers |
| Release | After a push to `master` passes CI, the release workflow builds that commit and pushes its dated tag |
| `stable` | Default channel: a maintainer points it, through the promote workflow, at the digest of a published dated tag (no rebuild, no new signature); every move comes with a [GitHub Release](https://github.com/marvinli001/edgeweir/releases) naming the matching node version, proto version, new database migrations, and upgrade steps |
| `latest` | Preview channel: follows `master`; moves only while the built commit is still the tip of `master`, never backwards |
| Manual release | Rebuilds the tip of `master` and pushes a new digest under the same dated tag |
| Source build | Version `dev` |
| Image labels | `org.opencontainers.image.version` is the dated tag; `org.opencontainers.image.revision` is the full commit ID |
| Signing | cosign keyless signature, with SBOM and SLSA provenance |
| All tags | [GitHub Packages](https://github.com/marvinli001/edgeweir/pkgs/container/edgeweir); a commit's changes are at `https://github.com/marvinli001/edgeweir/commit/<commit ID>` |

Edge nodes use their own semantic versions `vX.Y.Z`; see [node upgrades](../guide/node-upgrades.en.md). Security fixes land only on `master` and ship with the next `stable` and node patch release; they are not backported.

## Node compatibility

| Item | Rule |
| --- | --- |
| Matching versions | The "Compatibility" section of each `stable` GitHub Release names the matching edgeweir-node and proto versions |
| Basis | The console judges nodes by the [capabilities](../guide/node-upgrades.en.md#node-capabilities) they report, never by version number |
| Nodes lacking a capability | Keep their last good configuration and show "Upgrade required" under **Clusters & nodes**; the console account can publish such configurations, service accounts and background jobs get 409 `NODE_CAPABILITY_REQUIRED` |
| WebSocket entry | A `wss://` or `ws://` node channel URL needs edgeweir-node 0.2.0 or later; `install.sh` refuses older versions |
| Order | Upgrade the console first, then the nodes |

## Checking versions

| Object | Command or location |
| --- | --- |
| Running version | `version` in `curl -s http://127.0.0.1:3000/healthz`; "Version" under "System" in **System settings** |
| Dated tag of a channel | `docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' ghcr.io/marvinli001/edgeweir:stable` (after pulling; same for `latest`) |
| Digest of a tag | `Digest` in `docker buildx imagetools inspect ghcr.io/marvinli001/edgeweir:<tag>` |
| Migrations applied | `docker compose exec -T postgres psql -U edgeweir -d edgeweir -Atc 'select count(*) from drizzle.__drizzle_migrations'` |

## Pinning a version

Pin a dated tag in `.env`, optionally with its digest:

```bash title=".env"
EDGEWEIR_VERSION=20260929-a1b2c3d
# EDGEWEIR_VERSION=20260929-a1b2c3d@sha256:<digest>
```

| Item | Constraint |
| --- | --- |
| `stable` | Default in `compose.yml` when `EDGEWEIR_VERSION` is unset; `deploy.sh` resolves it to a dated tag and pins that |
| `latest` | Evaluation environments only |
| Digest | A manual release pushes a new digest under the same tag; pin the digest for an immutable reference |
| Automatic updates | Do not let Watchtower or a platform's auto-update follow a channel unattended: a start may run migrations, and upgrades follow a backup |
| `docker run` | The tag in the image reference sets the version; `EDGEWEIR_VERSION` is not passed into the container (inside the image it names the running version) |

## Verifying the image signature

```bash
cosign verify ghcr.io/marvinli001/edgeweir:<tag> \
  --certificate-identity https://github.com/marvinli001/edgeweir/.github/workflows/release.yml@refs/heads/master \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

gh attestation verify oci://ghcr.io/marvinli001/edgeweir:<tag> --repo marvinli001/edgeweir
```

The certificate identity is the release workflow on `master`; `stable` and its dated tag are the same digest with the same signature. Verifying node packages and other release artifacts: [安全策略](../../SECURITY.md).

## Pre-upgrade checks

| Check | Method |
| --- | --- |
| Current version | Note `version` from `/healthz`, for a [downgrade](downgrade.en.md) |
| Release notes | Read "Compatibility" and "Upgrade" in every GitHub Release after the current version; note new migrations and required node versions |
| Database backup | Back up as in [backup and recovery](backup.en.md); confirm `pg_restore --list` reads it |
| Keys | `EDGEWEIR_MASTER_KEY` (and `BETTER_AUTH_SECRET`, if set) has an offline copy |
| Signature | Verify the target tag as in the previous section |
| Nodes | Nodes under **Clusters & nodes** are "Online" and "In sync"; note each node's "Agent / engine" version |
| Disk | Free space on the database volume's disk exceeds the database size: a migration may rewrite tables |

## Upgrade

Docker Compose:

1. Complete the [pre-upgrade checks](#pre-upgrade-checks).
2. Set `EDGEWEIR_VERSION`:

   ```bash
   sed -i 's|^#* *EDGEWEIR_VERSION=.*|EDGEWEIR_VERSION=20260930-b2c3d4e|' .env
   ```

3. Pull and recreate:

   ```bash
   docker compose pull
   docker compose up -d
   ```

4. Check as in [post-upgrade verification](#post-upgrade-verification).

### Other deployment methods

| Deployment | Upgrade | Details |
| --- | --- | --- |
| BaoTa / aaPanel (`deploy.sh`) | `./deploy.sh update` (`stable` channel) or `./deploy.sh update <tag>`; backs up to `backups/<time>-before-<target>/` first | [deploy.sh reference](deploy-script.en.md#update) |
| BaoTa / aaPanel panel | Set `EDGEWEIR_VERSION` in `.env` and update the image in the panel (aaPanel **Update Image**); the panel does not back up the database, back it up first | [BaoTa / aaPanel](baota.en.md#upgrades-and-backups) |
| `docker run` | `docker pull ghcr.io/marvinli001/edgeweir:<new tag>`; `docker rm -f edgeweir-console`; recreate it with the same options and the new tag | [Standalone containers](docker.en.md#without-compose-standalone-containers) |
| Railway | The update button in the `edgeweir` service's **Settings**, or `railway redeploy --service edgeweir --from-source --yes` | [Railway](railway.en.md#upgrade) |
| Fly.io | `fly deploy` in the directory of `fly.toml` | [Fly.io](fly.en.md#upgrade) |
| bunny.net | **Apply Update** on the app page, or update the container's digest with `bunny api` | [bunny.net](bunny.en.md#upgrade) |
| Render | Set the image URL to the new tag, then **Manual Deploy → Deploy latest reference** | [Render](render.en.md#upgrade) |
| Zeabur | Set the tag in **Settings → Service Image** to the new version, or `npx zeabur@latest service update tag -t <new tag>` | [Zeabur](zeabur.en.md#upgrade) |
| Source build | Check out the target commit and run `docker compose up -d --build` | — |

Railway, Render, bunny.net and Zeabur start the new instance and stop the old one after its health check passes: both versions run briefly side by side, and node channel connections to the old instance drop and reconnect.

### Startup steps

Every console start runs these steps in order. If one fails, the process exits non-zero and the container restarts per its restart policy.

| Order | Step | Log on failure |
| --- | --- | --- |
| 1 | Validate environment variables | One line per problem: `invalid configuration: <variable>: <reason>` |
| 2 | Wait for the database, up to 60 seconds | `database not reachable yet` (with `attempt`); certificate errors add a `hint` |
| 3 | Apply migrations not yet applied: serialized by an advisory lock, all migrations in one transaction; safe with several instances starting at once | The migration's SQL error; the transaction rolls back and the schema stays as before |
| 4 | Check that the master key matches the database | `EDGEWEIR_MASTER_KEY does not match this database` |
| 5 | Check the session secret | `BETTER_AUTH_SECRET is not set, but this database was used with another secret` |
| 6 | Re-encrypt legacy ciphertexts not bound to their record ID | `cannot upgrade a legacy envelope` |
| 7 | After a master key rotation, re-encrypt ciphertexts of the previous key with the new key | `cannot re-seal an envelope of the previous master key` |
| 8 | Start web, API and node channel (`ROLE` `all`, `app`) and the worker (`ROLE` `all`, `worker`) | — |

| Rule | Description |
| --- | --- |
| Migration direction | Forward only, no down scripts; to go back see [downgrade](downgrade.en.md) |
| Legacy ciphertexts | Newer versions no longer read the legacy format: upgrade all console instances together |
| Configuration recompile | When an upgrade changes what stored data compiles to, the worker publishes every cluster once (reason "Configuration recompiled after an upgrade"); a cluster whose publish fails keeps its revision, log `recompile after upgrade failed` |
| Nodes | Not upgraded with the console; see [node upgrades](../guide/node-upgrades.en.md) |

## Post-upgrade verification

| Check | Pass condition |
| --- | --- |
| Version | `curl -s http://127.0.0.1:3000/healthz` returns `{"status":"ok","version":"<new tag>"}` |
| Container | `console` is `healthy` in `docker compose ps` |
| Migrations | The log has `database migrated` and no error lines: `docker compose logs console \| grep '"level":"error"'` prints nothing |
| Worker | The log has `worker started` |
| Nodes | Nodes under **Clusters & nodes** are "Online" and "Applied" is "In sync" |
| Sign-in | The existing account signs in; two-factor authentication works |

On failure see [troubleshooting](troubleshooting.en.md); to go back see [downgrade](downgrade.en.md).

## Upgrading a multi-organization console

The console has one account and no organizations, members, roles, or separate admin area. Upgrading from a version with several organizations or accounts runs migrations `0033`–`0036` automatically at startup.

Before the upgrade:

1. Back up the database: these migrations delete account and organization data, and going back requires the pre-upgrade backup; see [downgrade](downgrade.en.md).
2. Confirm that the earliest-created platform administrator who is not disabled can sign in: after the upgrade it is the only account.
3. Review pending domains: after the upgrade they route directly; delete domains that should not route.

| Object | After the upgrade |
| --- | --- |
| Account | The earliest-created platform administrator who is not disabled becomes the only account and keeps its password, two-factor authentication, and passkeys; other accounts are deleted with their sessions, passkeys, and AccessKeys |
| Alert subscriptions | Subscriptions of other accounts move to the kept account: one per channel, with those subscriptions' sites and the union of their alert kinds |
| Data | Sites, certificates, DNS credentials, bans, IP lists, rules, alerts, statistics, and audit logs of every organization are kept |
| IP lists | Organization lists become "Referenced by rules"; a name already taken gets the suffix `_<6 hex digits>`, and that organization's site rules follow the new name |
| Site state | Enabled or disabled only: sites in another offline state become disabled |
| Domains | Pending domains route directly; a domain on several sites stays on one: the verified one first, otherwise the earliest added |
| Removed settings | Organization technical limits, organization two-factor requirement and default cluster, the per-organization OWASP CRS switch, the ownership-check DNS setting, organization scopes of service accounts |
| Environment | `EDGEWEIR_DNS_RESOLVERS` is no longer read; remove it from `.env` |
| Configuration | The worker publishes every cluster once, so formerly unverified domains and merged IP lists reach the nodes |
| Pages | Bookmarks `/admin/<page>` open the matching page (`/admin/settings` opens `/system`); other `/admin` URLs open the overview |

| API change | Interfaces |
| --- | --- |
| Removed | `organizations.*`, `members.*`, `invitations.*`, `users.*`, `admin.*` (including `/admin/sites`, `/admin/organizations/{id}/limits`, `/admin/bans`), `platformIpLists.*` (`/platform-ip-lists`), `domainOwnership.*` and `/sites/{id}/ownership*`, `settings.waf`, `settings.dnsResolvers` |
| Fields | Site, ban, certificate, usage, and audit records no longer carry organization fields |
| Paths | Node upgrades are `/api/v1/node-upgrades` and `/api/v1/node-releases/{version}`, without the `/admin` prefix; bans only `/api/v1/bans`, IP lists only `/api/v1/ip-lists` |
