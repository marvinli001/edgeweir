# Troubleshooting

Symptoms, causes, and fixes for console startup, sign-in, node channel, background job, DNS and certificate, and performance problems.

Collect first:

```bash
curl -s http://127.0.0.1:3000/healthz
docker compose ps
docker compose logs --tail 200 console | grep -E '"level":"(warn|error)"'
```

For `deploy.sh` deployments use `./deploy.sh status` and `./deploy.sh logs console`. Log format: [logs](maintenance.en.md#logs).

## Startup failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| `invalid configuration: <variable>: <reason>`, the process exits | An environment variable is missing or malformed; one line per problem | Fix the variables listed; all variables in [environment variables](../reference/environment.en.md) |
| `EDGEWEIR_MASTER_KEY: is not valid base64` or `must be at least 32 bytes` | The master key was truncated or altered: quotes or spaces in the value, or a panel turned `+` into a space | Use the output of `openssl rand -base64 32` as is |
| `EDGEWEIR_MASTER_KEY_PREVIOUS: is the same key as EDGEWEIR_MASTER_KEY` | Both variables got the same value during a rotation | Set `EDGEWEIR_MASTER_KEY_PREVIOUS` to the key from before the rotation; see [master key rotation](maintenance.en.md#master-key-rotation) |
| `<variable>_FILE: set either <variable> or <variable>_FILE, not both` | Both the variable and its file variable are set | Keep one |
| `<variable>_FILE: cannot read <file>` or `<file> is empty` | The file is not mounted, not readable (the image runs as uid 1000), or empty | Check the mount and `chown 1000` |
| `EDGEWEIR_PUBLIC_URL: expected http:// or https://host[:port] without a path` | The URL has a path or query, or a platform variable did not expand (e.g. `https://${DOMAIN}`) | Use `https://host[:port]` |
| `EDGEWEIR_NODE_API_URL: expected https://, wss:// or ws://host[:port] without a path` | As above; or the port-forward variables of the old Zeabur template did not expand | Fix the URL; for Zeabur see [migrating from the old template](zeabur.en.md#migrating-a-deployment-from-the-old-template) |
| `database not reachable yet` repeats, exit after 60 seconds | Database not running, wrong address or credentials, no network path | `docker compose ps postgres`; for an external database check `DATABASE_URL` and the firewall |
| `database not reachable yet` with `hint`: `node-postgres verifies the server certificate for sslmode=require too` | With `sslmode=require` node-postgres also verifies the server certificate | Add `sslrootcert=<CA file>` to `DATABASE_URL`; or use `uselibpqcompat=true&sslmode=require` (no certificate check) or `sslmode=no-verify` |
| A migration reports `permission denied` | The `DATABASE_URL` user lacks `CREATE` on the database or the `public` schema | Make the user the database owner or grant `CREATE`; a failed migration rolls back, restart after the fix |
| Startup stops at the migrations, no `database migrated` in the log | Another console instance is migrating, or a leftover session holds the migration lock | Wait for the other instance; find the holder with `select pid from pg_locks where locktype = 'advisory' and objid = 727274` and, once it is confirmed unused, `select pg_terminate_backend(<pid>)` |
| `EDGEWEIR_MASTER_KEY does not match this database` | The master key is not the one of this database: it was replaced, or the database comes from another installation | Restore the original key; to replace it, set the original as `EDGEWEIR_MASTER_KEY_PREVIOUS` as in [master key rotation](maintenance.en.md#master-key-rotation). Setting `BETTER_AUTH_SECRET` does not help |
| `BETTER_AUTH_SECRET is not set, but this database was used with another secret` | `BETTER_AUTH_SECRET` was removed from an existing deployment | Restore the original value |
| `the stored session secret cannot be opened with the configured master key` | The session secret stored after a master key rotation cannot be opened: the master key was replaced by a third value | Restore the master key from after the rotation |
| An old version starts but requests fail; the log names missing columns or tables | An old image runs on a database a newer version migrated | Restore from a backup as in [downgrade](downgrade.en.md#downgrade-from-a-backup), or return to the newer version |
| `console` is `unhealthy` while the process runs | `/healthz` does not answer: startup not finished (waiting for the database, migrating) | `docker compose logs console` shows the step it is in; see [startup steps](upgrade.en.md#startup-steps) |
| `shutdown timed out`, exit code 1 | Requests in flight, node connections, and pg-boss did not close within 8 seconds on stop | The process exits before the container runtime's default 10-second kill; keep a platform's stop grace period at 10 seconds or more |

## Sign-in and sessions

| Symptom | Cause | Fix |
| --- | --- | --- |
| The console redirects to `/setup` and there is no setup token | Not initialized yet; the setup token is logged at every start | `docker compose logs console \| grep setupToken`; `./deploy.sh setup-token` for `deploy.sh` deployments |
| Sign-in fails or reports an untrusted origin | `EDGEWEIR_PUBLIC_URL` differs from the browser's address in scheme, host, or port | Fix `EDGEWEIR_PUBLIC_URL` and recreate the container |
| Back on the sign-in page right after signing in | With an `https://` `EDGEWEIR_PUBLIC_URL` the session cookie is `Secure`; browsers do not keep it over `http://` | Use HTTPS; reverse proxies in [reverse proxy for the web console](networking.en.md#reverse-proxy-for-the-web-console) |
| "Too many requests; try again later" | Sign-in rate limit; counters live in the database, shared by all instances, and survive restarts | Retry after 10 seconds |
| The limit hits everyone at once; the audit log shows one IP for all requests | A reverse proxy in front, `EDGEWEIR_TRUSTED_PROXIES` unset, so every request counts as the proxy's | Set `EDGEWEIR_TRUSTED_PROXIES`; see [trusted proxies and client IP](networking.en.md#trusted-proxies-and-client-ip) |
| "This IP is not on the login allow list" | The current address is not on the login IP allow list | Use a network on the list; or run `recover.js --clear-login-allowlist` on the server; see [account recovery](maintenance.en.md#account-recovery) |
| Forgotten password, lost two-factor device and backup codes | — | [Account recovery](maintenance.en.md#account-recovery) |
| Everyone signed out and two-factor fails after changing `BETTER_AUTH_SECRET` | TOTP secrets and backup codes are encrypted with the old secret | Restore the old value; if it is lost, turn two-factor off on the server and enable it again |
| A passkey cannot sign in | The console's host name changed; passkeys are bound to the old one | Sign in with the password, delete the old passkey, add a new one |

Other sign-in messages: [account troubleshooting](../guide/account.en.md#troubleshooting).

## Node channel

| Symptom | Cause | Fix |
| --- | --- | --- |
| Startup log `the node channel URL names this machine only` or `is a private address` | The node channel URL is `localhost` or a private address: nodes in other networks cannot enroll or connect | Save a public URL under "Node channel" in **System settings**, or set `EDGEWEIR_NODE_API_URL` |
| Startup log `EDGEWEIR_PUBLIC_URL is plain HTTP` | The console serves `install.sh` over HTTP; nodes run an unencrypted script as root | Serve the console over HTTPS |
| Connection check "Certificate mismatch: a proxy or CDN may be in front"; node reports `CA pin mismatch` | A proxy or CDN in front of 8443 terminates TLS; the console must terminate node channel TLS itself (mTLS) | Connect directly or use [passthrough](networking.en.md#node-channel-passthrough); set Cloudflare records to DNS only |
| Connection check "The console cannot connect to this URL" | Wrong resolution, port not published or not allowed | Check the publishing of `EDGEWEIR_NODE_API_PORT` and the firewall; `curl -k https://<address>:8443/` on a node returns 404 |
| `install.sh`: `answers 404: the console's WebSocket entry is closed` | The node channel URL is `wss://` or `ws://` and the console's WebSocket entry is closed | Save that URL in **System settings**, or set `EDGEWEIR_NODE_API_WEBSOCKET=true`; see [the WebSocket entry](networking.en.md#the-node-channels-websocket-entry) |
| `install.sh`: `cannot reach the node channel WebSocket entry` | The reverse proxy does not forward the WebSocket upgrade on `/node-channel`, or the node does not trust the certificate | Configure the proxy as in [the WebSocket entry](networking.en.md#the-node-channels-websocket-entry) |
| Node `x509: certificate is valid for ..., not ...` | The name the node connects to is not in the node channel server certificate | Add the name to `EDGEWEIR_NODE_API_HOSTNAMES` and restart the console; see [node channel URL and certificate](networking.en.md#node-channel-url-and-certificate) |
| Node shows "Certificate expired" | The node was offline longer than its certificate's remaining lifetime (30-day certificates) and could not renew it | Enroll again on the node with a new install command plus `--force`, then delete the old node in the console |
| Nodes disconnect and reconnect periodically on a platform | The platform replaces instances (deploys, restarts, maintenance) and closes connections | Nodes reconnect and serve their last good configuration meanwhile; see the platform page's "Limitations" |
| "Connects from" in node details is not the node's public address | The platform's TCP proxy or HTTP ingress does not pass the node's address | Expected; see the platform page's "Limitations" |

Enrollment and node-side errors: [node enrollment troubleshooting](nodes.en.md#troubleshooting) and [node troubleshooting](../node/troubleshooting.en.md).

## Background jobs

| Symptom | Cause | Fix |
| --- | --- | --- |
| Certificates not renewed, DNS not synced, no alerts, old data not deleted | No worker runs: every instance has `ROLE=app` | Run at least one instance with `ROLE=all` or `ROLE=worker`; the log shows `worker started` |
| Log `pg-boss error` | The worker's database connection or a query failed | Check database availability and its connection limit; pg-boss reconnects |
| `failed` jobs of a queue keep growing | That job fails on every run | Find the queue with the query in [background jobs](maintenance.en.md#background-jobs) and search the log for errors of that module |
| After an upgrade some clusters got no new configuration; log `recompile after upgrade failed` | Publishing that cluster failed; it keeps its revision | Fix the error for the logged `clusterId`; the next change to that cluster publishes |
| A canary does not advance, node upgrade tasks expire | No worker, or nodes do not meet the health window | Check the worker; node upgrades in [node upgrade troubleshooting](../guide/node-upgrades.en.md#troubleshooting) |
| `envelopes still use EDGEWEIR_MASTER_KEY_PREVIOUS` stays after a master key rotation | Some ciphertexts cannot be re-encrypted | Follow the table and record in the `cannot re-seal an envelope of the previous master key` lines; see [master key rotation](maintenance.en.md#master-key-rotation) |

## DNS and certificates

| Symptom | Cause | Fix |
| --- | --- | --- |
| Certificate state "Issuance failed" | The reason on the card: domain validation, CAA, rate limits, EAB, and so on | See [HTTPS troubleshooting](../guide/https.en.md#troubleshooting) |
| A self-hosted ACME directory, DNS endpoint, or webhook cannot be reached; outbound policy refusal | The target resolves to a private or reserved address, which the outbound policy refuses by default | Allow the range in `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |
| The custom ACME directory's certificate is not trusted | The ACME directory uses a private CA | Save the CA certificate under the certificate authorities in **System settings**, or set `EDGEWEIR_ACME_CA_FILE` |
| Certificates cannot be issued when running from source | The certificate helper `edgeweir-certd` was not built | Build it and set `EDGEWEIR_CERTD_BIN`; see [command line](../reference/cli.en.md#run-locally) |
| DNS records not updated, held back, or removed | Provider credentials, quotas, or the mass-removal guard | See [DNS steering troubleshooting](../guide/dns.en.md#troubleshooting) |
| Alerts not delivered | Channel settings, SMTP ports blocked by the platform, send rate limit | See [Alerts troubleshooting](../guide/alerts.en.md#troubleshooting) |

## Performance and resources

| Symptom | Cause | Fix |
| --- | --- | --- |
| The database keeps growing | High access log sample rate or long retention; high node log limits; the audit log is never deleted | Adjust per [retention](maintenance.en.md#retention); move high access log volume to ClickHouse |
| Statistics and log pages are slow | Large access log volume in PostgreSQL | Shorten retention, lower the sample rate, or use ClickHouse; see [access logs](../guide/access-logs.en.md#use-clickhouse-storage) |
| API returns 429 "Too many requests with this access key; try again in N s" | The access key's request limit was exceeded; counted per process | Retry after `retryAfterSeconds` and lower concurrency |
| "This cluster has reached its limit of 512 published sites" | The cluster's enabled sites reached the limit | Disable unused sites, or create sites in another cluster |
| Container memory near its limit, OOM-killed | Instance too small | Confirm with `docker stats --no-stream`; adjust per [runtime requirements](README.en.md#runtime-requirements) or split web and worker per [process roles](README.en.md#process-roles) |
| Disk full | Old images, container logs without a size limit, backups | See [disk and resources](maintenance.en.md#disk-and-resources) |
