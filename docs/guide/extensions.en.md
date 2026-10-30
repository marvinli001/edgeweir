# Extensions

Node extensions add Lua code from a publisher you trust to the edge request path: headers, verdicts, rule fields, HTML snippets, small endpoints. The console installs and configures them and turns them on per site; nodes verify and load them. The format and runtime contract is in [Node extensions](../reference/extensions.en.md).

> An extension runs inside the node's nginx workers with their privileges and sees the requests and responses of every site that turns it on. Trust a publisher key only if you would run that publisher's code on your edge (see the threat model in SECURITY.en.md).

## Concepts

| Term | Definition |
| --- | --- |
| Package | A `.ewx` file (gzip ustar: `manifest.json`, `lua/`, `assets/`) and its `.ewx.sig` signature |
| Publisher key | An Ed25519 public key (JWK) you trust for one publisher name; its kid is the key's RFC 7638 thumbprint. There are none by default |
| Version | Every uploaded package of an extension id is kept; one is active |
| Capabilities | What the package may do (verdicts, change headers, read bodies, inject HTML, rewrite bodies, open connections, timers); shown before installing |
| Failure mode | `open` (default): a failing extension is skipped. `closed`: requests on its sites get 503 while it fails |
| Kill switch | Stops every extension on every node at once; packages and settings stay |

## Installing

1. Open **System** → **Extensions**.
2. Under **Trusted keys**, add the publisher's public key (JWK, or its `x`) with the publisher name the publisher gave you. Compare the kid with the one the publisher publishes.
3. Click **Install**, choose the `.ewx` and `.ewx.sig` files. The console verifies the package and shows its name, version, publisher, key, hooks and capabilities; nothing is stored yet.
4. Click **Install** again. A new extension starts **off**; installing a newer version of an installed extension switches to it.
5. Open the extension, fill in its global settings, choose the failure mode and turn it **on**.

## Turning it on for a site

1. Open **Sites** → choose the site → **Extensions**.
2. Turn the extension on and fill in its site settings; **Save**.

Settings, enabling and the kill switch are hot updates. Installing, upgrading or removing an extension that a site uses reloads nginx on the nodes of that site's cluster. While an active node of the cluster lacks `extensions-v1` (an older node, or one started with `--no-extensions`), enabling is refused.

## Rules, logs and statistics

| Where | What |
| --- | --- |
| Rules | Fields the extension declares, `ext.<id>.<name>`, in request phases (for example `ext.hello-header.greeted eq true`). An extension or version still read by rules cannot be removed |
| Access logs | Block reason **Extension** with rule `ext:<id>`; the extension's log fields and verdicts |
| Statistics | The extension's counters and `ext.<id>.faults` per site and minute |
| Extension page | Per node: loaded, pending, failed or unsupported, with fault and trip counts |

## Nodes

| Flag | Effect |
| --- | --- |
| `--no-extensions` | The node never downloads or runs extensions and does not announce `extensions-v1` |
| `--extension-keys FILE` | The node accepts only packages signed by keys in this local file (one JWK per line, or a JSON array), whatever the console trusts |

## Removing

- **Delete version** removes a version that is not active.
- **Uninstall** removes the extension, its versions and its site settings, after rules stop using its fields. Nodes delete the unpacked package after the next configuration.
- Removing a trusted key is refused while installed versions are signed by it.
