# Node logs

Local node logs (journal), the Logs tab of a node's details in the console (warnings, errors and events), and debug logs pulled on demand.

## Local logs

Nodes write no log files: the agent, the supervisor and OpenResty log to standard error, which is the journal under systemd and the container log in a container.

| Source | Content | View |
| --- | --- | --- |
| Agent, supervisor | `--log-level` (default `info`) and above, in the `--log-format` (`text` or `json`) | `journalctl -u edgeweir-node` |
| OpenResty error log | `notice` and above, passed line by line into the node's log with the field `component=nginx` | Same |
| Access logs | Nodes write no access log file; sampled access logs go to the console, see [Access logs](access-logs.en.md) | Live: `sudo edgeweir-node accesslog` |
| Probes | As the agent | `journalctl -u edgeweir-probe` |

```bash title="Node"
journalctl -u edgeweir-node -f
journalctl -u edgeweir-node --since "1 hour ago" | grep -E 'level=(WARN|ERROR)'
journalctl -u edgeweir-node -o cat | grep 'component=nginx'
docker logs -f edgeweir-node
```

More detail: set `EDGEWEIR_LOG_LEVEL=debug` in `/etc/default/edgeweir-node` and restart the service, and set it back afterwards; or [pull debug logs](#debug-logs) from the console without a restart. Flags: [Node configuration](../node/configuration.en.md#logs).

## The Logs tab

The **Logs** tab of a node's details lists the entries the node uploaded, newest first, refreshed every 10 seconds. Each shows time, level, source and message; opening one shows its structured fields.

| Source | What is collected |
| --- | --- |
| Agent | Warnings and errors of `edgeweir-node`, such as failed configuration applies, failed node channel connections, certificates that do not load |
| Supervisor | Warnings and errors of `edgeweir-node supervise`, such as upgrade rollbacks |
| OpenResty | Entries of OpenResty's error log at warn and above (crit, alert and emerg become errors; the original level is in the field `severity`), such as failed origin connections and upstream timeouts |
| Lua | Warnings and errors from the data plane's Lua code, such as an origin marked down after repeated failures (including failed name resolution) |

Entries with the level **Event** are only: "Agent started", "Configuration applied", "Serving the last-known-good configuration", "OpenResty started", "Node certificate renewed", "Node channel address switched", "Upgrade applied", "OpenResty logs arrive after the node service restarts". Other info-level logs are not uploaded and stay in the local journal.

OpenResty's request context is in the fields: `client` (visitor address), `server`, `request` (request line), `upstream`, `host`, `referrer`.

### Filters

| Filter | Detail |
| --- | --- |
| Level | All levels, Warnings and errors, Errors |
| Source | Agent, Supervisor, OpenResty, Lua |
| Time | Last hour, Last 24 hours, Last 7 days, or Any time |
| Search | Text the message contains, case-insensitive |

100 entries per page; **Load more** goes further back. API: `GET /api/v1/nodes/{id}/logs` (parameters `minLevel`, `source`, `from`, `to`, `q`, `cursor`, `limit`; returns `nextCursor`).

### Redaction

The node removes the following before storing an entry, and the console checks again when storing it:

- Query strings in URLs and request lines (replaced as a whole by `[redacted]`, signed URLs included)
- User names and passwords in URLs
- PEM blocks (certificates, private keys)
- Values of `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, and `Bearer` tokens
- Values of fields and key-value pairs whose names contain token, secret, password, api key, access key, private key, auth key, signature, credential or session id
- Tokens and keys the console issues (`ewt_`, `ewp_`, `ews_`, `ewk_`) and JWTs

A message holds at most 2048 bytes, an entry at most 16 fields, field names at most 64 bytes and field values at most 512 bytes; the rest is cut and the entry marked **Truncated**. The demo account sees visitor addresses cut to /24 (IPv4) or /48 (IPv6).

### Rate limits and drops

| Item | Behavior |
| --- | --- |
| Folding | Of identical entries (same source, level and message, numbers and IDs ignored) 3 per window are kept and the rest fold into one "{count} more like this"; the window is 1 minute and grows to 5 minutes, 15 minutes and 1 hour while the repetition goes on |
| Rate | Each node uploads up to 5 entries per second of its own processes (bursts of 50) and 10 per second of OpenResty (bursts of 100) |
| Spooling | While the console is unreachable entries wait in `nodelogs-spool.json` in the state directory (at most 5000 entries, 4 MiB) and are uploaded in order afterwards; when the agent restarts, upgrades or crashes, the OpenResty entries the supervisor holds are kept |
| Drops | Entries dropped over the rate or spool limits show as one line "The node dropped N entries (… over its rate limit, … with full buffers)" |

## Debug logs

The **Logs** tab holds warnings, errors and events only. **Pull debug logs** on the same tab fetches the node's in-memory logs of every level:

| Item | Behavior |
| --- | --- |
| Buffer | The node keeps recent logs in memory: agent and supervisor at debug and above, OpenResty's error log at every level; 5000 entries by default and at most 4 MiB, the oldest dropped first; never written to disk, never uploaded unless pulled |
| Pull options | Time (Whole buffer, Last 15 minutes, Last hour), sources and components (such as `channel`, `tasks`, comma-separated, at most 16, lowercase letters, digits, `_`, `.` and `-` only) |
| Upload | The node uploads the matching entries once, at most 10,000 entries and 4 MiB; beyond that it keeps the newest part, marked **Newest part only** |
| Failures | "The node did not upload within 2 minutes", "The node's debug buffer is off", "Node version too old" (no `debug-logs-v1`), "Upload failed"; one open pull per node at a time |
| Viewing | A finished pull can be opened with **View** (filter by level and message) or saved with **Download** as JSON Lines |
| Retention | The last 10 pulls per node, deleted after as many days as the node log retention |
| Access | Entries are redacted like the **Logs** tab; the demo account can view and download but not pull; every pull is audited |
| Node flag | `--debug-log-buffer` sets the number of entries (`0` turns it off, at most 100,000) |
| Old supervisor | While an older supervisor still runs after a remote upgrade, results are marked "Supervisor and OpenResty entries missing" until the node service restarts |

API: `POST /api/v1/nodes/{id}/debug-logs` (`from`, `to`, `components`, `sources`), `GET /api/v1/nodes/{id}/debug-logs`, `GET /api/v1/nodes/{id}/debug-logs/{pullId}`.

## Retention

**Node log retention** in **System settings**: 1–30 days kept (default 7), 1,000–100,000 entries per node (default 10,000). The console deletes entries beyond them at startup and every 10 minutes. Deleting a node deletes its logs.

## Node versions

| Case | Behavior |
| --- | --- |
| The node does not report `node-logs-v1` | The tab shows "Node version too old"; upgrades: [Node upgrades](node-upgrades.en.md) |
| An older supervisor still runs after a remote upgrade | Only agent entries are uploaded, plus one entry "OpenResty logs arrive after the node service restarts"; `sudo systemctl restart edgeweir-node` restores them |
| `edgeweir-node run` without `--manage-nginx` | Agent entries only |
