# 面向代理的 Markdown

请求在 `Accept` 中列出 `text/markdown` 时，节点把网站的 HTML 响应转换为 Markdown 返回，供 AI 代理与爬虫读取；浏览器与其他客户端照常收到 HTML。行为与 Cloudflare 的 Markdown for Agents 兼容。转换失败或超出范围时返回原 HTML。

## 概念

| 术语 | 定义 |
| --- | --- |
| Markdown 请求 | GET 或 HEAD，`Accept` 明确列出 `text/markdown` 且 q > 0。`text/*`、`*/*` 不算。 |
| 有资格的路径 | 路径最后一段没有扩展名，或扩展名是 `html` `htm` `xhtml` `shtml` `php` `asp` `aspx` `jsp` `jspx` `cfm` `cgi` `pl` `do` `action`（不区分大小写）；以某个包含前缀开头（没有包含前缀时为全部路径），且不以任何排除前缀开头。 |
| 变体 | 被缓存的请求在同一 URL 下有两份缓存对象：HTML 与 Markdown。缓存键只区分这两类，不包含访客的 `Accept`。 |
| Markdown 响应数 | 以 Markdown 完整返回的 200 GET 响应数（含缓存命中）。 |

## 开启

1. 打开 **网站** → 选择网站 →「缓存」页签。
2. 在「面向代理的 Markdown」卡片打开「开启」，按需填写包含与排除的路径前缀（每行一个），点击「保存」。
3. 「Markdown 响应」卡片显示所选时间范围内的 Markdown 响应数。

不需要缓存规则：不被缓存的请求每次都转换。设置是热更新，不重载 nginx。集群里有活动节点不支持 `markdown-v1` 时，卡片显示「集群中有节点不支持」；已开启的可以关闭。

## 设置

| 设置 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- |
| 开启 | 关 | — | 关闭时保留前缀 |
| 包含前缀 | 空（全部路径） | 最多 32 个，每个最多 256 字节 | 以 `/` 开头的 ASCII 可见字符，按字节比较，区分大小写 |
| 排除前缀 | 空 | 同上 | 优先于包含前缀 |

## 行为

| 情况 | 结果 |
| --- | --- |
| 路径没有资格 | 不转换，响应与关闭时相同，不加 `Vary: Accept` |
| 有资格的路径返回 `text/html`、`application/xhtml+xml` 或 `text/markdown` | 响应带 `Vary: Accept`（HTML 也带） |
| Markdown 请求 | 节点向源站取完整文档（不分片；HEAD 以 GET 回源），把 2xx 的 `text/html` 转换为 `text/markdown; charset=utf-8` |
| 转换结果 | YAML 头信息（`title`、`description`、`image`，取自 `<meta name>`，其次 `og:`，标题最后取 `<title>`），正文，最后是页面的 JSON-LD（`json` 代码块）。去掉导航、页眉页脚、侧栏、表单、脚本、样式与隐藏元素；页面只有一个可见的 `<main>`（或 `role="main"`）时只转换它。保留标题、列表、链接、图片、表格、代码与引用；链接与图片地址转为绝对地址（按 `<base href>` 与页面 URL） |
| 响应头 | `X-Markdown-Tokens`（估算的 token 数）；源站没有 `Content-Signal` 时加 `Content-Signal: ai-train=yes, search=yes, ai-input=yes`；去掉 `ETag`、`Last-Modified`、`Content-Encoding`、`Content-Range`、`Accept-Ranges` |
| 字符集 | 按 `Content-Type` 的 `charset`，其次文档中的声明（如 GBK、Shift_JIS），输出统一为 UTF-8 |
| 源站响应不是 2xx（或是 204、205、206）、不是 HTML、超过 6 MiB（gzip 解压后）、gzip 以外的 `Content-Encoding`、转换后为空（如只有脚本的单页应用） | 原样返回，照常缓存在 Markdown 变体下 |
| 转换失败或超时 | 原 HTML，照常缓存 |
| 节点繁忙（转换名额或内存都已占满，等待 1 秒），或源站没有在 `--markdown-timeout` 内传完 | 原 HTML，最多缓存 60 秒，之后再试 |
| 缓存命中 | 直接返回缓存的 Markdown，不再转换 |
| 刷新 URL、前缀、主机或 Cache-Tag，或清空网站缓存 | HTML 与 Markdown 变体一起刷新 |
| Range | 不分片，返回完整 Markdown |

Markdown 响应数只统计完整的 200 GET 响应；HEAD 不计。

## 节点上的限制

转换在节点 agent 的子进程中进行，每次转换只用一个 CPU。以下是节点参数（也可用环境变量 `EDGEWEIR_<NAME>` 设置），修改后重启 `edgeweir-node`：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--markdown-workers` | min(4, max(1, CPU 数 / 2)) | 同时进行的转换数；0 关闭转换，节点不上报 `markdown-v1` |
| `--markdown-memory-mb` | `512` | 正在进行的转换合计可用的内存。每次转换按 HTML 大小估算（24 × 字节数 + 48 MiB）；等待转换的 HTML 在 agent 内存中所占的字节同样受这个总量限制 |
| `--markdown-timeout` | `5s` | 单次转换的最长时间，超时后返回原 HTML |

一个 300 KB 的页面转换约 10 毫秒。

## 验证

```bash
# Markdown：第一次 MISS，第二次 HIT
curl -s -D - -H 'Accept: text/markdown' https://docs.example.com/guide/ | head -20
# 浏览器得到 HTML
curl -s -o /dev/null -D - -H 'Accept: text/html' https://docs.example.com/guide/ | grep -iE '^(x-cache|content-type|vary):'
```

节点日志中每次转换一行 `Markdown converted`（HTML 字节、Markdown 字节、耗时）；失败与超时为 `Markdown conversion failed` / `Markdown conversion timed out`，繁忙时为 `HTML kept for now`。

## 限制

- 只转换 HTML；PDF、图片、JSON 等原样返回。
- 不执行 JavaScript：靠脚本渲染内容的页面返回原 HTML。
- 被缓存的 URL 的 HTML 与 Markdown 各占一份缓存空间。
- 不区分代理与浏览器：任何列出 `text/markdown` 的请求都会得到 Markdown。

## 故障排查

| 现象 | 检查 |
| --- | --- |
| 总是返回 HTML | `Accept` 是否明确列出 `text/markdown`；路径是否有资格（扩展名、包含与排除前缀）；源站是否返回 2xx 的 `text/html`、不超过 6 MiB；页面是否靠脚本渲染；节点日志 |
| 卡片无法开启 | 集群中的活动节点都升级到支持 `markdown-v1` 的版本，且没有以 `--markdown-workers 0` 运行 |
| 「Markdown 响应」显示部分节点不统计 | 集群中有活动节点不支持 `markdown-v1`，它们的响应不计入 |
| Markdown 缺少正文 | 正文在 `<nav>`、`<aside>`、页面级 `<header>` / `<footer>` 或隐藏元素中；页面有一个 `<main>` 而正文在它之外 |
