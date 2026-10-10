# Image format conversion

Converts a site's cached JPEG and PNG responses to WebP or AVIF by the visitor's `Accept`: the node converts once on a cache miss and caches the result as a variant; when a conversion fails or an image is out of range, the original is served. Conversion keeps the size, does not crop and reads no URL parameters.

## Concepts

| Term | Definition |
| --- | --- |
| Variant | The three cached objects of one URL: the original, WebP and AVIF. The cache key tells only these three apart; it does not contain the visitor's `Accept`. |
| Negotiation | The node picks the class from `Accept`: AVIF when `image/avif` is named explicitly (q > 0) and the site offers AVIF, otherwise WebP when `image/webp` is named explicitly (q > 0) and the site offers WebP, otherwise the original. |
| Source types | The originals converted: `image/jpeg`, `image/png`. |
| Saved bytes | For every complete 200 response served as a variant (cache hits included), the bytes it has less than the original, summed. |

## Turning it on

1. Open **Sites** → choose the site → the **Cache** tab.
2. Make sure a **cache rule** caches the paths of the images: only cached requests are converted.
3. In the **Image format conversion** card, turn on **On**, choose WebP, AVIF (or both) and their quality, the source types and, if needed, the size and pixel **Limits**; click **Save**.
4. The **Saved by conversion** card shows the bytes saved over the chosen range.

Settings are hot updates; nginx does not reload. While an active node of the cluster lacks `image-convert-v1`, the card shows "Some nodes of the site's cluster do not support it yet"; a conversion that is on can still be turned off.

## Settings

| Setting | Default | Range | Notes |
| --- | --- | --- | --- |
| On | off | — | Turning it off keeps the other settings |
| WebP | on | — | At least one format |
| WebP quality | 80 | 1–100 | Lossy encoder quality |
| AVIF | off | — | Smaller, but a conversion needs about 3–4 times the memory of WebP |
| AVIF quality | 50 | 1–100 | |
| Source types | JPEG, PNG | at least one | PNG is encoded lossily too; choose only JPEG when icons or screenshots must stay lossless |
| Smallest original (bytes) | 1024 | 0–67108864 | Smaller originals are not converted |
| Largest original (bytes) | 10485760 | 1–67108864 | Larger originals are not converted; not below the smallest |
| Most pixels | 16000000 | 1–50000000 | Images whose width × height is larger are not converted |

## Behaviour

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
| An ICC profile that is not sRGB (e.g. Display P3), CMYK JPEG, a PNG whose `gAMA` is not 1/2.2 without an `sRGB` chunk, animated PNG, arithmetic-coded or 12-bit JPEG | The original, cached as usual |
| The variant is not smaller, the conversion fails or times out | The original, cached as usual |
| The node is busy (conversion slots or memory taken, after waiting 1 second) | The original, cached for at most 60 seconds, then tried again |
| Purging a URL, prefix or Cache-Tag | Every variant of the URL is purged with it |
| HEAD, Range | Answered from the cached variant |

Saved bytes count complete 200 GET responses only; HEAD and 206 do not count.

## Limits on the node

Conversions run in child processes of the node's agent, one CPU each. These are node flags (also `EDGEWEIR_<NAME>` environment variables); restart `edgeweir-node` after changing them:

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

## Limitations

- Only JPEG and PNG are converted; GIF, SVG, WebP and AVIF are served as they are.
- No resizing, cropping, watermarks or transformations by URL parameters.
- Each variant takes its own cache space; at most three objects per URL.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Always JPEG | Does a cache rule cache the request (`X-Cache` is not `BYPASS`)? Does `Accept` name `image/webp` or `image/avif`? Is it a navigation (`Accept` with `text/html`)? Is the image out of the size or pixel range, not sRGB, or smaller than the variant? The node's log |
| The card cannot be turned on | Upgrade the cluster's active nodes to a version with `image-convert-v1`; none may run with `--image-workers 0` |
| High node memory | Lower `--image-workers` or `--image-memory-mb`, or lower **Most pixels** or turn AVIF off on the site |
