# Image format conversion

Image format conversion on a site's Cache tab: nodes convert cached JPEG and PNG to WebP or AVIF by `Accept`, cache variants, and fall back to the original.

## Concepts

| Term | Definition |
| --- | --- |
| Variant | The three cached objects of one URL: the original, WebP and AVIF. The cache key tells only these three apart; it does not contain the visitor's `Accept`. |
| Negotiation | The node picks the class from `Accept`: AVIF when `image/avif` is named explicitly (q > 0) and the site offers AVIF, otherwise WebP when `image/webp` is named explicitly (q > 0) and the site offers WebP, otherwise the original. |
| Source types | The originals converted: `image/jpeg`, `image/png`. |
| Saved bytes | For every complete 200 GET response served as a variant (cache hits included), the bytes it has less than the original, summed. |

Conversion keeps the size, does not crop, and reads no URL parameters.

## Turning it on

1. Open **Sites**, select the site, and open the **Cache** tab.
2. Make sure a **Cache rules** entry caches the paths of the images: only cached requests are converted (the card notes "Converts cached images only").
3. In the **Image format conversion** card, turn on **On**; in the **WebP** and **AVIF** groups turn on the formats to offer and set their **Quality**; under **Source types** choose **JPEG** and/or **PNG**; change **Smallest original (bytes)**, **Largest original (bytes)**, and **Most pixels** under **Limits** as needed.
4. Click **Save**.
5. Verify: see [Verifying](#verifying); the **Saved by conversion** card shows the bytes saved over the chosen range.

## Settings

| Field | API field | Values | Default | Effect |
| --- | --- | --- | --- | --- |
| On | `enabled` | On / off | Off | Turning it off keeps the other settings |
| WebP: On | `webp` | On / off | On | Offers WebP; at least one of WebP and AVIF |
| WebP: Quality | `webpQuality` | Whole number 1–100 | 80 | Lossy encoder quality |
| AVIF: On | `avif` | On / off | Off | Offers AVIF; smaller files, but a conversion needs about 3–4 times the memory of WebP |
| AVIF: Quality | `avifQuality` | Whole number 1–100 | 50 | Lossy encoder quality |
| Source types: JPEG | `jpeg` | On / off | On | Converts `image/jpeg`; at least one of JPEG and PNG |
| Source types: PNG | `png` | On / off | On | Converts `image/png`, also lossily; turn it off when icons or screenshots must stay lossless |
| Limits: Smallest original (bytes) | `minSize` | 0–67108864 | 1024 | Smaller originals are not converted; not above the largest |
| Limits: Largest original (bytes) | `maxSize` | 1–67108864 | 10485760 | Larger originals are not converted |
| Limits: Most pixels | `maxPixels` | 1–50000000 | 16000000 | Images whose width × height is larger are not converted |

| Item | Behavior |
| --- | --- |
| Validation | The settings are checked as a whole, also while off. Both formats off shows "Choose at least one format", both source types off "Choose at least one source type", the smallest original above the largest "The smallest original cannot be larger than the largest" |
| Applying | A save publishes a revision of the site's cluster (reason `site_updated`, audit `site.image_convert_update` with the names of the changed fields and `enabled`); nodes apply it as a hot update without reloading nginx. Changes while conversion is off do not change the node configuration and create no revision |
| Node requirement | Node capability `image-convert-v1`; while an active node of the cluster lacks it, the card shows "Some nodes in the cluster do not support it", **On** is unavailable while off, and a conversion that is on can still be turned off. A node running with `--image-workers 0` refuses configurations that turn conversion on |

## Saved by conversion

The **Saved by conversion** card shows the bytes saved over the chosen range.

| Item | Meaning |
| --- | --- |
| Range | **Last hour**, **Last 6 hours**, **Last 24 hours** (default), **Last 7 days**, **Last 30 days** |
| Counting | Complete 200 GET responses only; HEAD and 206 do not count |
| Partial | While an active node of the cluster lacks `image-convert-v1`, the card shows "Some nodes in the cluster do not convert images" |

## Behavior

| Case | Result |
| --- | --- |
| The request is not cached (no cache rule applies, bypassed, `Authorization` without a rule that caches it, not GET / HEAD, WebSocket, gRPC) | No conversion; the response is as if it were off |
| `Accept` names `text/html` (q > 0: a browser navigation, e.g. opening the image in a new tab) | The original |
| The path's last segment has an extension other than the source types' (JPEG: `.jpg` `.jpeg` `.jpe` `.jfif`; PNG: `.png`; any case) | No variants, no `Vary: Accept` |
| A path without an extension | Negotiated as usual; the origin's `Content-Type` decides whether it is converted |
| `Accept` has only `*/*` or `image/*` (curl's default, for example) | The original |
| An eligible request answered with `image/jpeg`, `image/png`, `image/webp`, `image/avif` | `Vary: Accept` (the original's too) |
| A variant's cache miss | The node fetches the whole original from the origin (no slices), converts and caches it; later requests for that variant hit |
| A variant response | `Content-Type: image/webp` / `image/avif`; `ETag` with `-webp` / `-avif` inside the quotes; cached as long as the original; no metadata (EXIF, XMP, ICC) |
| The original has an EXIF orientation | The pixels are turned upright before encoding; it looks like the original |
| The origin answers other than 200, with a `Content-Encoding`, another type than the source types, or out of the size or pixel range | The original, cached under that variant as usual |
| An ICC profile that is not sRGB (e.g. Display P3) or over 64 KiB, CMYK JPEG, a PNG whose `gAMA` is not 1/2.2 without an `sRGB` chunk, a PNG with more than one `iCCP` chunk or with both `iCCP` and `sRGB`, animated PNG, arithmetic-coded or 12-bit JPEG | The original, cached as usual |
| The variant is not smaller, the conversion fails or times out | The original, cached as usual |
| The node is busy (conversion slots or memory taken, after waiting 1 second) | The original, cached for at most 60 seconds, then tried again |
| The original has not arrived within `--image-timeout` | The original (streamed on), cached for at most 60 seconds, then tried again |
| Purging a URL, directory or Cache-Tag | Every variant of the URL is purged with it |
| HEAD, Range | Answered from the cached variant |

## Limits on the node

Conversions run in child processes of the node's agent, one CPU each. These are node flags (also `EDGEWEIR_<NAME>` environment variables, such as `EDGEWEIR_IMAGE_WORKERS`); restart `edgeweir-node` after changing them:

| Flag | Default | Notes |
| --- | --- | --- |
| `--image-workers` | min(4, max(1, CPUs / 2)) | Concurrent conversions; 0 turns conversion off and the node does not announce `image-convert-v1` |
| `--image-memory-mb` | `1024` | Memory the running conversions may use together. Each conversion is estimated from its pixels (WebP about 48 bytes per pixel + 32 MiB, AVIF about 160 bytes per pixel + 64 MiB); images whose estimate exceeds the total are not converted. Originals held in the agent's memory before their conversion count against the same total |
| `--image-timeout` | `8s` | Longest conversion; the original is served after it |

With the defaults, AVIF converts images up to about 6 megapixels and WebP up to about 20; larger images reach AVIF clients as the original.

## Verifying

```bash
# MISS the first time, HIT the second, type image/webp
curl -s -o /dev/null -D - -H 'Accept: image/webp,*/*' https://img.example.com/photo.jpg | grep -iE '^(x-cache|content-type|vary):'
# AVIF
curl -s -o /dev/null -D - -H 'Accept: image/avif,image/webp,*/*' https://img.example.com/photo.jpg | grep -iE '^(x-cache|content-type):'
# The original
curl -s -o /dev/null -D - https://img.example.com/photo.jpg | grep -iE '^(x-cache|content-type|vary):'
```

The node logs one `image converted` line per conversion (original and variant bytes, pixels, time and CPU time); timeouts and failures log `image conversion timed out` / `image conversion failed`.

## API

Paths are relative to `/api/v1`, see [API and endpoints](../reference/api.en.md).

| Procedure | Method and path | Notes |
| --- | --- | --- |
| `imageConvert.get` | `GET /sites/{id}/image-convert` | The site's settings; the defaults (off) when never saved |
| `imageConvert.update` | `PUT /sites/{id}/image-convert` | Replaces the settings as a whole, every field of [Settings](#settings) required; publishes the cluster |
| `imageConvert.savings` | `GET /sites/{id}/image-convert/savings` | `range`: `1h`, `6h`, `24h` (default), `7d`, `30d`; returns `bytesSaved` and `unsupportedNodes` (active nodes without `image-convert-v1`) |
| `sites.features` | `GET /sites/{id}/features` | `imageConvert` tells whether the cluster can turn conversion on |

Settings that fail the [validation](#settings) answer 400. Service accounts cannot call these procedures. Copying settings and cloning a site copy the image format conversion settings too, see [Site management](site-management.en.md).

## Limits

| Item | Description |
| --- | --- |
| Formats | Only JPEG and PNG are converted; GIF, SVG, WebP and AVIF are served as they are |
| Transformations | No resizing, cropping, watermarks or transformations by URL parameters |
| Cache space | Each variant takes its own cache space; at most three objects per URL |

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| Always the original, `X-Cache: BYPASS` | No cache rule caches the request | Add a cache rule for the image paths, see [Configure cache rules](origins-and-cache.en.md#configure-cache-rules) |
| Always the original, without `Vary: Accept` | The path's extension is not one of the chosen source types' | Choose the matching source type, or use extensions such as `.jpg` and `.png` |
| Always the original, with `Vary: Accept` | `Accept` names neither `image/webp` nor `image/avif` explicitly, or names `text/html`; the image is out of the size or pixel range, not sRGB, or the variant is not smaller; the conversion failed or timed out | Check with the requests under [Verifying](#verifying); look for `image conversion failed` / `image conversion timed out` in the node log |
| **On** is unavailable with "Some nodes in the cluster do not support it" | An active node of the cluster lacks `image-convert-v1`, or runs with `--image-workers 0` | Upgrade the nodes, see [Node upgrades](node-upgrades.en.md); drop `--image-workers 0` |
| Saving shows "Choose at least one format", "Choose at least one source type", or "The smallest original cannot be larger than the largest" | The settings fail validation | Change them as the message says |
| A node stays on an old configuration revision | It runs with `--image-workers 0` and refuses configurations that turn conversion on | Change that node's `--image-workers` and restart it, or turn conversion off |
| High node memory | Too many concurrent conversions or too many pixels | Lower `--image-workers` or `--image-memory-mb`, or lower **Most pixels** or turn AVIF off on the site |
