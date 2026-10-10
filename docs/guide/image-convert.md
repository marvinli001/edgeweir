# 图片格式转换

把网站被缓存的 JPEG 与 PNG 按访客的 `Accept` 转换为 WebP 或 AVIF：节点在缓存未命中时转换一次，结果作为变体缓存；转换失败或超出范围时返回原图。转换不改变尺寸，不裁剪，也不读取 URL 参数。

## 概念

| 术语 | 定义 |
| --- | --- |
| 变体 | 同一 URL 的三类缓存对象：原图、WebP、AVIF。缓存键只区分这三类，不包含访客的 `Accept`。 |
| 协商 | 节点按 `Accept` 选择类别：明确列出 `image/avif`（q > 0）且网站开启 AVIF 时为 AVIF，否则明确列出 `image/webp`（q > 0）且网站开启 WebP 时为 WebP，否则为原图。 |
| 源类型 | 会被转换的原图类型：`image/jpeg`、`image/png`。 |
| 节省的字节数 | 每个以变体完整返回的 200 响应（含缓存命中）比原图少的字节数之和。 |

## 开启

1. 打开 **网站** → 选择网站 →「缓存」页签。
2. 确认「缓存规则」会缓存图片所在的路径：只有被缓存的请求才转换。
3. 在「图片格式转换」卡片打开「开启」，选择 WebP、AVIF（可都选）与质量，选择源类型，按需修改「限制」中的大小与像素数，点击「保存」。
4. 「格式转换节省」卡片显示所选时间范围内节省的字节数。

设置是热更新，不重载 nginx。集群里有活动节点不支持 `image-convert-v1` 时，卡片显示「所在集群有节点不支持，暂时无法开启」；已开启的可以关闭。

## 设置

| 设置 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- |
| 开启 | 关 | — | 关闭时保留其余设置 |
| WebP | 开 | — | 至少开启一种格式 |
| WebP 质量 | 80 | 1–100 | 有损编码质量 |
| AVIF | 关 | — | AVIF 更小，但转换时需要的内存约为 WebP 的 3–4 倍 |
| AVIF 质量 | 50 | 1–100 | |
| 源类型 | JPEG、PNG | 至少一种 | PNG 同样有损编码；图标、截图类 PNG 不希望有损时只选 JPEG |
| 最小原图（字节） | 1024 | 0–67108864 | 小于此值的原图不转换 |
| 最大原图（字节） | 10485760 | 1–67108864 | 大于此值的原图不转换；不能小于最小原图 |
| 最大像素数 | 16000000 | 1–50000000 | 宽 × 高超过此值的图片不转换 |

## 行为

| 情况 | 结果 |
| --- | --- |
| 请求不会被缓存（没有缓存规则命中、被绕过、带 `Authorization` 且规则不缓存、非 GET / HEAD、WebSocket、gRPC） | 不转换，响应与关闭时相同 |
| `Accept` 含 `text/html`（q > 0，浏览器导航，例如在新标签页打开图片） | 原图 |
| 路径最后一段有扩展名，且不是所选源类型的扩展名（JPEG：`.jpg` `.jpeg` `.jpe` `.jfif`；PNG：`.png`；不区分大小写） | 不区分变体，不加 `Vary: Accept` |
| 路径没有扩展名 | 照常协商；回源后按 `Content-Type` 决定是否转换 |
| `Accept` 只有 `*/*` 或 `image/*`（如 curl 的默认值） | 原图 |
| 有资格的请求返回 `image/jpeg`、`image/png`、`image/webp`、`image/avif` | 响应带 `Vary: Accept`（原图也带） |
| 变体缓存未命中 | 节点向源站取完整原图（不分片），转换后缓存；同一变体之后的请求直接命中 |
| 变体响应 | `Content-Type: image/webp` / `image/avif`；`ETag` 在引号内加 `-webp` / `-avif`；缓存时间与原图相同；不带任何元数据（EXIF、XMP、ICC） |
| 原图带 EXIF 方向 | 像素按方向转正后再编码，显示与原图一致 |
| 源站响应不是 200、带 `Content-Encoding`、类型不是所选源类型、大小或像素数超出范围 | 原图，照常缓存在该变体下 |
| 原图带非 sRGB 的 ICC 配置（如 Display P3）、CMYK JPEG、`gAMA` 不是 1/2.2 且没有 `sRGB` 块的 PNG、动画 PNG、算术编码或 12 位 JPEG | 原图，照常缓存 |
| 转换结果不比原图小、转换失败或超时 | 原图，照常缓存 |
| 节点繁忙（转换名额或内存都已占满，等待 1 秒） | 原图，最多缓存 60 秒，之后再试 |
| 刷新 URL、前缀或 Cache-Tag | 同一 URL 的全部变体一起刷新 |
| HEAD、Range | 由缓存的变体回答 |

节省的字节数只统计完整的 200 GET 响应；HEAD 与 206 不计。

## 节点上的限制

转换在节点 agent 的子进程中进行，每次转换只用一个 CPU。以下是节点参数（也可用环境变量 `EDGEWEIR_<NAME>` 设置），修改后重启 `edgeweir-node`：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--image-workers` | min(4, max(1, CPU 数 / 2)) | 同时进行的转换数；0 关闭转换，节点不上报 `image-convert-v1` |
| `--image-memory-mb` | `1024` | 正在进行的转换合计可用的内存。每次转换按像素估算（WebP 约 48 字节 / 像素 + 32 MiB，AVIF 约 160 字节 / 像素 + 64 MiB）；估算超过总量的图片不转换。等待转换的原图在 agent 内存中所占的字节同样受这个总量限制 |
| `--image-timeout` | `8s` | 单次转换的最长时间，超时后返回原图 |

按默认值，AVIF 可转换约 6 百万像素以内的图片，WebP 约 2 千万像素以内；更大的图片对接受 AVIF 的访客返回原图。

## 验证

```bash
# 第一次 MISS，第二次 HIT，类型为 image/webp
curl -s -o /dev/null -D - -H 'Accept: image/webp,*/*' https://img.example.com/photo.jpg | grep -iE '^(x-cache|content-type|vary):'
# AVIF
curl -s -o /dev/null -D - -H 'Accept: image/avif,image/webp,*/*' https://img.example.com/photo.jpg | grep -iE '^(x-cache|content-type):'
# 原图
curl -s -o /dev/null -D - https://img.example.com/photo.jpg | grep -iE '^(x-cache|content-type|vary):'
```

节点日志中每次转换一行 `image converted`（原图字节、变体字节、像素、耗时与 CPU 时间）；超时与失败为 `image conversion timed out` / `image conversion failed`。

## 限制

- 只转换 JPEG 与 PNG；GIF、SVG、WebP、AVIF 原样返回。
- 不缩放、不裁剪、不加水印，不按 URL 参数变换。
- 变体与原图各占一份缓存空间；同一 URL 最多三份。

## 故障排查

| 现象 | 检查 |
| --- | --- |
| 总是返回 JPEG | 请求是否命中缓存规则（`X-Cache` 不是 `BYPASS`）；`Accept` 是否明确列出 `image/webp` 或 `image/avif`；是否浏览器导航（`Accept` 含 `text/html`）；图片是否超出大小或像素范围、带非 sRGB 配置或比变体更小；节点日志 |
| 卡片无法开启 | 集群中的活动节点都升级到支持 `image-convert-v1` 的版本，且没有以 `--image-workers 0` 运行 |
| 节点内存占用高 | 调低 `--image-workers` 或 `--image-memory-mb`，或在网站上调低「最大像素数」、关闭 AVIF |
