# 图片格式转换

网站「缓存」页签的「图片格式转换」：节点按访客的 `Accept` 把被缓存的 JPEG 与 PNG 转换为 WebP 或 AVIF，结果作为变体缓存，失败或超出范围时返回原图。

## 概念

| 术语 | 定义 |
| --- | --- |
| 变体 | 同一 URL 的三类缓存对象：原图、WebP、AVIF。缓存键只区分这三类，不包含访客的 `Accept`。 |
| 协商 | 节点按 `Accept` 选择类别：明确列出 `image/avif`（q > 0）且网站开启 AVIF 时为 AVIF，否则明确列出 `image/webp`（q > 0）且网站开启 WebP 时为 WebP，否则为原图。 |
| 源类型 | 会被转换的原图类型：`image/jpeg`、`image/png`。 |
| 节省的字节数 | 每个以变体完整返回的 200 GET 响应（含缓存命中）比原图少的字节数之和。 |

转换不改变尺寸、不裁剪，也不读取 URL 参数。

## 开启

1. 打开 **网站**，选择网站，进入「缓存」页签。
2. 确认「缓存规则」会缓存图片所在的路径：只有被缓存的请求才转换（卡片提示「只转换会被缓存的图片」）。
3. 在「图片格式转换」卡片打开「开启」；在「WebP」「AVIF」两组中打开需要的格式并填写「质量」；在「源类型」中选择「JPEG」「PNG」；按需修改「限制」中的「最小原图（字节）」「最大原图（字节）」「最大像素数」。
4. 点击「保存」。
5. 验证：见[验证](#验证)；「格式转换节省」卡片显示所选时间范围内节省的字节数。

## 设置

| 字段 | API 字段 | 取值 | 默认值 | 作用 |
| --- | --- | --- | --- | --- |
| 开启 | `enabled` | 开 / 关 | 关 | 关闭时保留其余设置 |
| WebP：开启 | `webp` | 开 / 关 | 开 | 提供 WebP；WebP 与 AVIF 至少开一种 |
| WebP：质量 | `webpQuality` | 1–100 的整数 | 80 | 有损编码质量 |
| AVIF：开启 | `avif` | 开 / 关 | 关 | 提供 AVIF；文件更小，转换时需要的内存约为 WebP 的 3–4 倍 |
| AVIF：质量 | `avifQuality` | 1–100 的整数 | 50 | 有损编码质量 |
| 源类型：JPEG | `jpeg` | 开 / 关 | 开 | 转换 `image/jpeg`；JPEG 与 PNG 至少开一种 |
| 源类型：PNG | `png` | 开 / 关 | 开 | 转换 `image/png`，同样有损编码；图标、截图类 PNG 不希望有损时关闭 |
| 限制：最小原图（字节） | `minSize` | 0–67108864 | 1024 | 小于此值的原图不转换；不能大于最大原图 |
| 限制：最大原图（字节） | `maxSize` | 1–67108864 | 10485760 | 大于此值的原图不转换 |
| 限制：最大像素数 | `maxPixels` | 1–50000000 | 16000000 | 宽 × 高超过此值的图片不转换 |

| 项目 | 行为 |
| --- | --- |
| 校验 | 关闭时同样整体校验。两种格式都关闭时提示「至少选择一种格式」，两种源类型都关闭时提示「至少选择一种源类型」，最小原图大于最大原图时提示「最小原图不能大于最大原图」 |
| 生效 | 保存后发布网站所在集群的配置版本（原因 `site_updated`，审计 `site.image_convert_update`，元数据为修改的字段名与 `enabled`），节点热更新，不重载 nginx；关闭期间的修改不改变节点配置，不产生新版本 |
| 节点要求 | 节点能力 `image-convert-v1`；集群有活动节点不支持时卡片显示「集群中有节点不支持」，未开启时「开启」不可用，已开启的可以关闭。以 `--image-workers 0` 运行的节点拒绝开启了转换的配置 |

## 格式转换节省

「格式转换节省」卡片显示所选时间范围内节省的字节数。

| 项目 | 说明 |
| --- | --- |
| 时间范围 | 「过去 1 小时」「过去 6 小时」「过去 24 小时」（默认）「过去 7 天」「过去 30 天」 |
| 计数 | 只统计完整的 200 GET 响应；HEAD 与 206 不计 |
| 部分节点 | 集群有活动节点不支持 `image-convert-v1` 时显示「集群中有节点不支持格式转换」 |

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
| 原图带非 sRGB 的 ICC 配置（如 Display P3）、超过 64 KiB 的 ICC 配置、CMYK JPEG、`gAMA` 不是 1/2.2 且没有 `sRGB` 块的 PNG、有多个 `iCCP` 块或同时有 `iCCP` 与 `sRGB` 块的 PNG、动画 PNG、算术编码或 12 位 JPEG | 原图，照常缓存 |
| 转换结果不比原图小、转换失败或超时 | 原图，照常缓存 |
| 节点繁忙（转换名额或内存都已占满，等待 1 秒） | 原图，最多缓存 60 秒，之后再试 |
| 原图在 `--image-timeout` 内没有传完 | 原图（边传边转发），最多缓存 60 秒，之后再试 |
| 刷新 URL、目录或 Cache-Tag | 同一 URL 的全部变体一起刷新 |
| HEAD、Range | 由缓存的变体回答 |

## 节点上的限制

转换在节点 agent 的子进程中进行，每次转换只用一个 CPU。以下是节点参数（也可用环境变量 `EDGEWEIR_<NAME>` 设置，如 `EDGEWEIR_IMAGE_WORKERS`），修改后重启 `edgeweir-node`：

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

## API

路径相对于 `/api/v1`，见 [API 与端点](../reference/api.md)。

| 过程 | 方法与路径 | 说明 |
| --- | --- | --- |
| `imageConvert.get` | `GET /sites/{id}/image-convert` | 网站的设置；从未保存时为默认值（关闭） |
| `imageConvert.update` | `PUT /sites/{id}/image-convert` | 整体替换设置，须给出[设置](#设置)中的全部字段；发布所在集群 |
| `imageConvert.savings` | `GET /sites/{id}/image-convert/savings` | `range`：`1h`、`6h`、`24h`（默认）、`7d`、`30d`；返回 `bytesSaved` 与 `unsupportedNodes`（不支持 `image-convert-v1` 的活动节点数） |
| `sites.features` | `GET /sites/{id}/features` | `imageConvert` 表示集群能否开启转换 |

设置不满足[校验](#设置)时返回 400。服务账号不能调用这些过程。复制设置与克隆网站一并复制图片格式转换设置，见[网站管理](site-management.md)。

## 限制

| 项目 | 说明 |
| --- | --- |
| 格式 | 只转换 JPEG 与 PNG；GIF、SVG、WebP、AVIF 原样返回 |
| 变换 | 不缩放、不裁剪、不加水印，不按 URL 参数变换 |
| 缓存空间 | 变体与原图各占一份缓存空间；同一 URL 最多三份 |

## 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 总是返回原图，`X-Cache: BYPASS` | 没有缓存规则缓存该请求 | 为图片路径添加缓存规则，见[配置缓存规则](origins-and-cache.md#配置缓存规则) |
| 总是返回原图，没有 `Vary: Accept` | 路径扩展名不是所选源类型的扩展名 | 选择对应的源类型，或使用 `.jpg`、`.png` 等扩展名 |
| 总是返回原图，带 `Vary: Accept` | `Accept` 没有明确列出 `image/webp` 或 `image/avif`，或含 `text/html`；图片超出大小或像素范围、带非 sRGB 配置或变体不比原图小；转换失败或超时 | 用[验证](#验证)中的请求检查；查看节点日志中的 `image conversion failed` / `image conversion timed out` |
| 「开启」不可用，显示「集群中有节点不支持」 | 集群有活动节点缺少 `image-convert-v1`，或以 `--image-workers 0` 运行 | 升级节点，见[节点升级](node-upgrades.md)；去掉 `--image-workers 0` |
| 保存提示「至少选择一种格式」「至少选择一种源类型」「最小原图不能大于最大原图」 | 设置不满足校验 | 按提示修改 |
| 某个节点停在旧配置版本 | 该节点以 `--image-workers 0` 运行，拒绝开启了转换的配置 | 调整该节点的 `--image-workers` 后重启，或关闭转换 |
| 节点内存占用高 | 转换并发或像素数过大 | 调低 `--image-workers` 或 `--image-memory-mb`，或在网站上调低「最大像素数」、关闭 AVIF |
