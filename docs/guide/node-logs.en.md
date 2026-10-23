# Node logs

A node's own warnings, errors and key events, in the console, without signing in to the node's host.

## Content

The **Logs** tab of a node's details lists its recent entries, newest first, refreshed every 10 seconds. Each entry shows its time, level, source and message; expand it for its structured fields.

| Source | What is collected |
| --- | --- |
| Agent | Warnings and errors of `edgeweir-node`, e.g. a configuration that failed to apply, node channel connection failures, certificates it cannot load |
| Supervisor | Warnings and errors of `edgeweir-node supervise`, e.g. an upgrade rolled back |
| OpenResty | Entries of OpenResty's error log at warn and above (crit, alert and emerg count as errors, the original level is in the field `severity`), e.g. origin connection failures and upstream timeouts |
| Lua | Warnings and errors written by the data plane's Lua code, e.g. an origin marked down after repeated failures (including name resolution failures) |

Events (level **Event**) are only these: agent started, configuration applied, last-known-good configuration served, OpenResty started, node certificate renewed, node channel address switched, upgrade applied. Other info-level logs are not uploaded; they stay on the node (`journalctl -u edgeweir-node`).

OpenResty's request context is in the fields: `client` (the visitor's address), `server`, `request` (the request line), `upstream`, `host`, `referrer`. For access logs see [Access logs and AccessKeys](access-logs.en.md).

## Filters

| Filter | Meaning |
| --- | --- |
| Level | All levels, warnings and errors, errors |
| Source | Agent, Supervisor, OpenResty, Lua |
| Time | Last hour, 24 hours, 7 days, or any time |
| Search | Text the message contains, in any case |

A page holds 100 entries; **Load more** continues with older ones. API: `GET /api/v1/nodes/{id}/logs` (parameters `minLevel`, `source`, `from`, `to`, `q`, `cursor`, `limit`; the answer has `nextCursor`).

## Redaction

The node removes the following before it keeps an entry, and the console checks again when it stores it:

- Query strings of URLs and request lines (replaced as a whole with `[redacted]`, signed URLs included)
- User names and passwords in URLs
- PEM blocks (certificates, private keys)
- Values of `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie` and `X-Api-Key`, and `Bearer` tokens
- Values of fields and key-value pairs whose name contains token, secret, password, api key, access key, private key, auth key, signature, credential or session id
- Tokens and keys the console issues (`ewt_`, `ewp_`, `ews_`, `ewk_`) and JWTs

A message is at most 2048 bytes, an entry has at most 16 fields of at most 512 bytes each; the rest is cut and the entry is marked **Truncated**. The demo account sees visitor addresses reduced to /24 (IPv4) or /48 (IPv6).

## Rate limits and drops

- Alike entries (same source, level and message, numbers and IDs aside) keep 3 a minute; the rest become one entry "N more like this". While they keep coming, the window grows up to an hour.
- A node uploads at most 5 entries a second of its own processes and 10 of OpenResty (short bursts allowed).
- While the console is unreachable, entries wait in the node's `nodelogs-spool.json` (at most 5,000) and go up in order once it is back; the supervisor keeps OpenResty's entries while the agent restarts, upgrades or crashes.
- Entries dropped over the rate limits or for full buffers show as one line "The node dropped N entries".

## Debug logs

The list above has warnings, errors and events only. When a problem needs more detail, choose **Pull debug logs** on the same tab:

- The node keeps its recent logs in memory at every level (the agent's and the supervisor's from debug up, every level of OpenResty's error log): 5,000 entries by default, at most 4 MiB, the oldest going first. Nothing is written to disk or uploaded until a pull asks for it.
- A pull may narrow the time (the whole buffer, the last 15 minutes, the last hour), the source and the components (e.g. `channel`, `tasks`, comma-separated). The node uploads the matching entries once, at most 10,000 entries and 4 MiB; beyond that only the newest part is kept and the pull shows **Newest part only**.
- A pull the node has not answered within 2 minutes fails. A node has at most one unfinished pull at a time.
- A finished pull can be viewed (filtered by level and message) or downloaded as a JSON Lines file. The last 10 pulls of each node are kept, for as many days as node logs.
- Entries are redacted like the list above; the demo account can view and download pulls but not start one. Each pull is recorded in the audit log.
- The node option `--debug-log-buffer` sets the number of entries (0 turns it off, at most 100,000). While an older supervisor still runs, pulls show **Supervisor and OpenResty entries missing** until the node service restarts.

API: `POST /api/v1/nodes/{id}/debug-logs` (`from`, `to`, `components`, `sources`), `GET /api/v1/nodes/{id}/debug-logs`, `GET /api/v1/nodes/{id}/debug-logs/{pullId}`.

## Retention

**System settings** → **Node log retention**: days kept 1–30 (7 by default), at most 1,000–100,000 entries per node (10,000 by default). The console deletes what is beyond them at its start and every 10 minutes. Deleting a node deletes its logs.

## Node versions

Nodes need a version that reports `node-logs-v1`; older nodes show **Node version too old**, see [Node upgrades](node-upgrades.en.md). After a remote upgrade, while the previous supervisor still runs, only the agent's entries arrive, with one event "OpenResty logs arrive after the node service restarts"; restarting the node service (`systemctl restart edgeweir-node`) brings them back. Nodes whose OpenResty is not run by the supervisor (`edgeweir-node run` without `--manage-nginx`) have the agent's entries only.
