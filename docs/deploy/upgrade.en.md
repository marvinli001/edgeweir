# Versions, upgrades, and rollback

Console image versioning, pinning, signature verification, upgrades, and rollback.

## Versioning

| Item | Rule |
| --- | --- |
| Image | `ghcr.io/marvinli001/edgeweir`, linux/amd64, linux/arm64, public |
| Tag | `<YYYYMMDD>-<commit>`: UTC commit date and the first 7 characters of the commit ID, e.g. `20260929-a1b2c3d`; the same commit always yields the same tag (`scripts/image-version.sh`) |
| Publishing | After a push to `master` passes CI, the release workflow builds the commit CI verified and pushes its tag; no semantic version numbers |
| `latest` | Moves only while that commit is still the tip of `master`; never moves backwards |
| Manual release | Rebuilds the tip of `master` and pushes a new digest under the same tag |
| Source build | Version `dev` |
| Image labels | `org.opencontainers.image.version` is the tag; `org.opencontainers.image.revision` is the full commit ID |
| Signatures | cosign keyless, with SBOM and SLSA provenance |
| All tags | [GitHub Packages](https://github.com/marvinli001/edgeweir/pkgs/container/edgeweir); the changes of a tag's commit are at `https://github.com/marvinli001/edgeweir/commit/<commit ID>` |

Edge nodes use separate `vX.Y.Z` versions; see [node upgrades](../guide/node-upgrades.en.md).

## Checking versions

| Target | Command or location |
| --- | --- |
| Running version | `version` from `curl -s http://127.0.0.1:3000/healthz`; "Version" under "System" in **Admin → System** |
| Tag behind `latest` | `docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' ghcr.io/marvinli001/edgeweir:latest` (after a pull) |
| Digest of a tag | `Digest` in the output of `docker buildx imagetools inspect ghcr.io/marvinli001/edgeweir:<tag>` |

## Pinning a version

Pin a dated tag in `.env`, optionally with its digest:

```bash title=".env"
EDGEWEIR_VERSION=20260929-a1b2c3d
# EDGEWEIR_VERSION=20260929-a1b2c3d@sha256:<digest>
```

| Item | Constraint |
| --- | --- |
| `latest` | Evaluation environments only |
| Digest | A manual release pushes a new digest under the same tag; pin the digest for an immutable reference. |
| Automatic updates | Do not follow `latest` unattended with tools such as Watchtower: every start may run migrations, and upgrades follow a backup. |
| `docker run` | The tag in the image reference selects the version; `EDGEWEIR_VERSION` stays out of the container environment. |

## Verifying the image signature

```bash
cosign verify ghcr.io/marvinli001/edgeweir:<tag> \
  --certificate-identity https://github.com/marvinli001/edgeweir/.github/workflows/release.yml@refs/heads/master \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

gh attestation verify oci://ghcr.io/marvinli001/edgeweir:<tag> --repo marvinli001/edgeweir
```

The certificate identity is the release workflow on the `master` branch. Node packages and other artifacts: [SECURITY.en.md](../../SECURITY.en.md).

## Upgrade

Docker Compose:

1. Back up the database and `.env`; see [backup and recovery](backup.en.md).
2. Verify the signature of the new tag as in the previous section.
3. Change `EDGEWEIR_VERSION`:

   ```bash
   sed -i 's|^#* *EDGEWEIR_VERSION=.*|EDGEWEIR_VERSION=20260930-b2c3d4e|' .env
   ```

4. Pull and recreate:

   ```bash
   docker compose pull
   docker compose up -d
   ```

5. Verify:

   ```bash
   curl -s http://127.0.0.1:3000/healthz
   docker compose ps
   ```

   Expected: `version` is the new tag; `console` is `healthy`.

At startup:

| Behavior | Description |
| --- | --- |
| Database migrations | Run at startup, serialized by an advisory lock; instances may start at the same time. Migrations only move forward; there are no down scripts. |
| Legacy ciphertext | Envelopes written by older versions without a record-id binding are re-encrypted with the master key at startup; new versions no longer read the old format, so all console instances are upgraded together. |
| Nodes | Not upgraded with the console; see [node upgrades](../guide/node-upgrades.en.md). |

Other deployment methods:

| Deployment | Upgrade |
| --- | --- |
| `deploy.sh` | `./deploy.sh update` or `./deploy.sh update <tag>`, which backs up first; see [deploy.sh reference](deploy-script.en.md). |
| `docker run` | `docker pull ghcr.io/marvinli001/edgeweir:<new tag>`, `docker rm -f edgeweir-console`, then recreate it with the same parameters and the new tag; data stays in the `edgeweir-postgres` volume. |
| Source build | Check out the target commit and run `docker compose up -d --build`. |

## Rollback

1. Check for new migrations between the two versions (in a repository checkout; commit IDs come from the tags):

   ```bash
   git diff --name-only <old commit> <new commit> -- packages/db/migrations/
   ```

2. Roll back according to the result:

   | Result | Rollback |
   | --- | --- |
   | No output: no new migrations | Set `EDGEWEIR_VERSION` back to the old tag and run `docker compose up -d`. With `deploy.sh`, run `./deploy.sh update <old tag>`. |
   | Migration files listed | Restore the pre-upgrade backup and start the old tag; see [backup and recovery](backup.en.md). |

3. Verify: `version` from `curl -s http://127.0.0.1:3000/healthz` is the old tag.
