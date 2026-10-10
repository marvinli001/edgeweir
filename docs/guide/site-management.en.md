# Managing many sites

Group sites with tags, act on several sites at once from the site list, copy one site's settings to other sites, or clone a new site from an existing one. Copying and cloning happen once: changing the source site later does not change the sites copied or cloned from it.

## Concepts

| Term | Definition |
| --- | --- |
| Tag | A group name of a site, 1–32 characters, case-insensitive (`Prod` and `prod` are one tag, shown as first written). A site has at most 10. Tags are used by the console only: nodes never receive them and changing tags publishes no configuration revision. |
| Batch action | Turning on, turning off, purging, adding tags, removing tags, copying settings or deleting the sites selected in the site list, up to 100 sites at once. |
| Copy settings | Writing the chosen parts of a source site's settings to target sites, replacing those settings of the targets. |
| Part | The unit of copying; see "Parts that can be copied". |
| Clone | A new site with every setting and the origins of a source site, under a new name and domains. |

## Tags

- **Add or change**: open **Sites → (site) → Overview**, click the edit button on the "Tags" row, type a name and press Enter (or a comma), then click "Save". Existing tags are suggested while typing. New sites and clones can get tags too.
- **Filter**: in the **Sites** list click "Tags" in the filter bar, tick one or more tags and choose "Any of them" or "All of them". Clicking a tag under a site's name shows the sites with that tag. The search box also finds sites by tag name.
- **In the command palette**: press ⌘K (Ctrl+K on Windows and Linux), type a tag name and choose "Tag: …" to open the list filtered by it.
- **Rename and delete**: click "Manage tags" in the filter bar. Renaming a tag to the name of another tag (in any case) merges the two. Deleting a tag takes it off every site. A tag no site uses stays listed until deleted.

## Batch actions

1. Tick sites in the **Sites** list (the box in the header selects the whole page). The selection stays across pages; changing the search or a filter clears it.
2. Choose an action in the bar at the bottom of the page:

| Action | Effect |
| --- | --- |
| Turn on / Turn off | Each site whose state changes gets an audit entry (the same as turning one site on or off); each cluster publishes one new revision, reason "N sites enabled" or "N sites disabled" (the site's own reason when only one site of the cluster changes). Sites already in that state stay as they are. |
| Purge cache | Creates one whole-site purge task for the selected sites; see each node's result under **Purge & prefetch**. |
| Add tags / Remove tags | Adds or removes tags on the selected sites. If a site would get more than 10 tags the whole action fails, naming the site. |
| Copy settings | Choose the source site and the parts, and copy them to the selected sites; see the next section. |
| Delete | Deletes only after you type the number of selected sites. Each site gets an audit entry; each cluster publishes once. |

A batch action completes for every site or changes none (for example when one of the selected sites has been deleted meanwhile).

## Copying settings

1. On a site's **Overview** click "Copy settings" and choose the target sites; or select the target sites in the site list, click "Copy settings" in the bar and choose the source site.
2. Tick the parts to copy and click "Preview".
3. The preview lists, for each target, how each part changes (list parts show "items before → items after", other parts the number of settings that change), and the targets that would fail with the reason. Previewing saves nothing.
4. Click "Copy to N sites". The result lists the parts each site got, or why it failed.

- Each target is saved on its own: a target that fails keeps its settings, the others are copied.
- Each target copied publishes a new revision of its cluster (reason "Settings of {source} copied to {site}"; none when the content does not change) and gets the audit entry "Site settings copied" with the source, the parts and the parts that actually changed.
- A copied part replaces that part of the target as a whole: for example the target's own site rules are all replaced by the source's.

### Parts that can be copied

| Part | Copied | Not copied |
| --- | --- | --- |
| Cache rules | Every cache rule | |
| Cache key and slicing | The cache key (query parameters, headers, cookies, device type, host) and Range slicing | |
| Cache-Tag | Whether the origin's Cache-Tag response header reaches visitors | |
| Compression | gzip, Brotli and Zstandard switches, levels, minimum lengths, types and the largest compressed length | |
| HTTPS options | Force HTTPS, HSTS, minimum TLS version, cipher profile, HTTP/2, HTTP/3, OCSP stapling, redirect status and port, client certificates | Certificates, the domains left out of the redirect |
| Site rules | Every rule of the site (all phases) and the largest request body rules read | |
| Bulk redirects | The whole redirect table | |
| Error pages | The error page of each status and "also replace origin error responses" | Maintenance mode |
| OWASP CRS | Mode, paranoia level, anomaly threshold, request body limit and exclusions | |
| CC and challenges | Under Attack, challenge type, pass lifetime, proof-of-work difficulty, CC policy, verified crawlers, challenge page texts, challenge failure bans | |
| Access control | Site lists, hotlink protection, user agents, CORS, regions, WebSocket origins, security headers | |
| Access authentication | Every authentication rule; password hashes and signing keys are encrypted again for the target | |
| Origin pool settings | Load balancing, timeouts, keep-alive, origin protocol, gRPC, active health checks, session affinity, retries, WebSocket | The origins |
| Log settings | The access log sample rate, logging blocked requests, the query string, request headers, the peer address and JA4 | |

Domains, origins, certificates, ports, X-Cache, the PURGE method and key, charset, the request body limit and maintenance mode belong to no part and are never copied.

### Why a copy fails

A target that lacks something the settings use fails:

| Message | What to do |
| --- | --- |
| Rule "…" chooses origin group …, which the site does not have | Add an origin group of that name on the target's "Origins" tab first. |
| The HTTPS redirect, HSTS and client certificates need a certificate on the site | The target has no certificate: give it one, or leave out "HTTPS options". |
| The site does not serve … / The site has no domain … | A bulk redirect source (`domain/path`) or an access authentication rule's domains name a domain the target does not have. |
| Redirect port … is not an HTTPS port of the site | Add the port to the target, or use 443 on the source. |
| IP list not found | An IP list the settings use was deleted during the copy. |

## Cloning a site

1. On a site's **Overview** click "Clone".
2. Enter a name (empty: the first domain) and the domains, change the tags if needed (the source's by default) and click "Clone".

The new site is in the source's cluster with the source's origins (S3 credentials encrypted again for it), every part that can be copied, X-Cache, the PURGE method and key (encrypted again), charset, the request body limit and maintenance mode. Certificates cover the source's domains and are not copied, so the clone has force HTTPS, HSTS and client certificates off and keeps only 443 of the HTTPS ports (80 when the source has no HTTP port). If the source's access authentication domains or bulk redirect sources name the source's domains, the clone fails with the reason. A clone gets the audit entry "Site cloned".

## API

| Action | Endpoint |
| --- | --- |
| Set a site's tags | `PUT /api/v1/sites/{id}/tags` |
| List, rename, delete tags | `GET /api/v1/site-tags`, `PATCH /api/v1/site-tags/{id}`, `DELETE /api/v1/site-tags/{id}` |
| List sites by tag | `GET /api/v1/sites?tagIds[]=<id>&tagIds[]=<id>&tagMatch=all` |
| Batch on/off, tags, delete | `POST /api/v1/sites/batch/enabled`, `/batch/tags`, `/batch/delete` |
| Preview and copy | `GET`, `POST /api/v1/sites/{id}/copy-settings` |
| Clone | `POST /api/v1/sites/{id}/clone` |

Fields and error codes are in the [API reference](../reference/api.en.md). A read-only AccessKey can list tags and preview a copy but not change anything; service accounts cannot call these endpoints.
