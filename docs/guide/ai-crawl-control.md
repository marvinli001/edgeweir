# AI 爬虫

识别声称是 AI 爬虫的请求并校验真伪，按爬虫或运营方放行、拦截、挑战或按抓取付费；托管 robots.txt；按网站查看爬虫流量。

## 概念

| 术语 | 定义 |
| --- | --- |
| 爬虫目录 | 控制台内置的爬虫清单：运营方、用途、User-Agent 标记、校验方式。随控制台版本更新，节点从配置中取得，从不在运行时下载。 |
| 声称 | User-Agent 含某个爬虫的标记（不区分大小写；多个匹配时取最长的标记，再取 id 较小者）。 |
| 校验 | 已验证：地址在运营方公布的网段内，或反向 DNS 落在运营方域名且正向解析回该地址。冒充：可以校验但未通过。无法校验：运营方没有公布校验方式。待定：DNS 查询失败或尚未完成。 |
| 动作 | 放行、拦截、挑战、收费；未设置时只标记，不改变请求。 |
| 按抓取付费 | Pay per crawl 协议：HTTP 402 与价格响应头。只实现协议，不处理付款。 |

## 爬虫目录

| 运营方 | 爬虫 | 用途 | 校验 |
| --- | --- | --- | --- |
| OpenAI | GPTBot、OAI-SearchBot、ChatGPT-User | 训练、AI 搜索、助手 | 公布网段 |
| Anthropic | ClaudeBot、Claude-SearchBot、Claude-User | 训练、AI 搜索、助手 | 无法校验 |
| Google | Googlebot、Google-CloudVertexBot、Google-Extended | 搜索引擎、训练 | 公布网段 / 反向 DNS；Google-Extended 只是 robots.txt 标记 |
| Microsoft | BingBot | 搜索引擎 | 公布网段 / 反向 DNS |
| Apple | Applebot、Applebot-Extended | AI 搜索、训练 | 公布网段 / 反向 DNS；Applebot-Extended 只是 robots.txt 标记 |
| ByteDance | Bytespider | 训练 | 无法校验 |
| Perplexity | PerplexityBot、Perplexity-User | AI 搜索、助手 | 公布网段 |
| Common Crawl | CCBot | 训练 | 公布网段 |
| DuckDuckGo | DuckAssistBot | 助手 | 公布网段 |
| Huawei | PetalBot | AI 搜索 | 反向 DNS |
| Meta | Meta-ExternalAgent、Meta-ExternalFetcher、FacebookBot | 训练、助手 | 无法校验 |
| Amazon | Amazonbot | 训练 | 反向 DNS |
| Mistral | MistralAI-User | 助手 | 公布网段 |
| Cohere | cohere-ai | 训练 | 无法校验 |

robots.txt 标记（Google-Extended、Applebot-Extended）不出现在请求中，只能放行或拦截，拦截写入托管 robots.txt。

## 动作

| 动作 | 节点行为 |
| --- | --- |
| 放行 | 转发到源站。已验证的爬虫还跳过 Under Attack 与 CC 挑战。 |
| 拦截 | 返回 403（内置错误页）或 402；可设置自定义文本。`X-Edgeweir-Error: ai-crawler-blocked`。 |
| 挑战 | 按所选挑战类型挑战，已有足够凭证时放行。 |
| 收费 | 按抓取付费；未开启按抓取付费时按拦截处理。 |

取值顺序：网站的爬虫动作 → 网站的运营方动作 → 全局爬虫动作 → 全局运营方动作。拦截、挑战与收费作用于所有声称者，不论校验结果；「冒充者」设置（不处理 / 拦截 / 挑战）另外作用于校验失败的请求，爬虫本身被拦截时仍拦截。

`/robots.txt` 永不拦截或挑战。动作在网站规则之后执行；放行规则、跳过挑战的规则、允许名单与 ACME 验证不受影响。拦截记为拦截原因 `ai_crawler`，按抓取付费的拒绝记为 `pay_per_crawl`。

## 设置

1. 全局：**防护设置 → 防护 → AI 爬虫**。「识别 AI 爬虫」开启时节点为访问日志与统计标记爬虫；在此设置所有网站的默认动作、冒充者、挑战类型与拦截响应。保存后向所有集群发布新配置。
2. 网站：**网站 →（网站）→ AI 爬虫** 的「AI 爬虫管控」卡片。按爬虫或运营方覆盖全局动作；冒充者、挑战类型与拦截响应可沿用全局。保存后热更新网站所在集群。

需要集群中的活动节点支持 `ai-crawlers-v1`；只开启识别时不需要。

## 托管 robots.txt

开启后，控制台生成下面的内容，节点在交付时放在源站 robots.txt 之前：

```text
# BEGIN Edgeweir managed content
User-agent: *
Content-Signal: search=yes, ai-train=no
Allow: /

User-agent: GPTBot
Disallow: /

# END Edgeweir managed content
```

- `Content-Signal` 行只在设置了内容信号（search、ai-input、ai-train：是 / 否）时出现。
- 被拦截或挑战的爬虫各有一组 `Disallow: /`；收费的爬虫不写入。
- 只处理 `GET` / `HEAD` 正好 `/robots.txt`：源站返回 200 纯文本且未压缩时前置；返回 404、410 或非文本的 200（应用的回退页）时只返回托管内容。
- 节点向源站请求该文件时去掉 `Accept-Encoding`、`Range` 与条件请求头，合并后的文件按网站的压缩设置由边缘压缩。改写发生在交付时，缓存保存的仍是源站文件。

## 按抓取付费

开启并设置价格（USD 0.001–1000）后，被设为「收费」的爬虫：

| 请求 | 响应 |
| --- | --- |
| 没有价格头 | 402，`crawler-price: USD 0.01`，`crawler-error: MissingCrawlerPrice` |
| `crawler-exact-price` 不等于价格 | 402，`InvalidCrawlerExactPrice` |
| `crawler-max-price` 低于价格 | 402，`InvalidCrawlerMaxPrice` |
| 同时带两个价格头 | 400，`ConflictingPriceHeaders` |
| 价格格式错误 | 400，`InvalidCrawlerPriceValue` |
| 未验证的爬虫带价格头 | 400，`StrongAuthRequired` |
| 价格可接受，源站返回 2xx | 正常响应加 `crawler-charged: USD 0.01`，访问日志与统计记录收费 |

价格格式为 `USD` 加最多 6 位小数。`/robots.txt`、`/sitemap.xml`、`/security.txt`、`/.well-known/security.txt`、`/crawlers.json` 免费。只有已验证的爬虫能付费。

「源站定价」：源站在响应头 `crawler-price` 中给出该响应的价格（无此头时用网站价格），格式错误时返回 502 `InvalidContentPrice`。`crawler-price` 只在 402 时发给客户端。

节点只记录收费，不收款；结算需要支付服务商，Edgeweir 不提供。

## 概览

**网站 →（网站）→ AI 爬虫** 的「AI 爬虫流量」，可按时间范围、运营方与爬虫筛选：

| 项目 | 含义 |
| --- | --- |
| 请求 | 声称 AI 爬虫的请求数，与上一个相同长度的时段对比 |
| 放行 / 失败 | 状态码低于 400 且未被拒绝 / 其余（拒绝、4xx、5xx） |
| 拦截 | 被 AI 爬虫动作拒绝（拦截、挑战、按抓取付费） |
| 流量 | 返回给爬虫的字节数 |
| 收费 | 带 `crawler-charged` 的请求数与金额 |
| robots.txt | 请求 robots.txt 的次数 |
| 爬虫卡片 | 按运营方分组，每个爬虫的请求、放行与失败、已验证 / 冒充 / 无法校验 |
| 热门路径 | 每个节点每分钟保留 64 个最多的路径，为近似值 |

访问日志的「爬虫」列与筛选显示声称的爬虫、校验结果与收费金额。

## 限制

- 不校验 Web Bot Auth 签名（需要运行时获取运营方密钥目录），不支持 `cf-pay-per-crawl` 请求头。
- 公布网段在控制台发版前更新（`pnpm --filter @edgeweir/contract ai-crawlers:ranges`），之后由运营方变化的网段会校验失败，直到下一个版本。
- 无法校验的爬虫的拦截与收费依赖 User-Agent，冒充者可绕过收费（换一个 User-Agent 即不再声称）。

## 故障排查

| 现象 | 检查 |
| --- | --- |
| 真实爬虫显示为冒充 | 地址是否在该版本的公布网段内（运营方近期是否新增网段）；反向 DNS 是否可用 |
| robots.txt 没有托管内容 | 源站是否返回 200 `text/plain`；网站是否设置了内容信号或有拦截 / 挑战的爬虫 |
| 设置卡片无法保存 | 集群中的活动节点都升级到支持 `ai-crawlers-v1` 的版本 |
| 概览数据偏少 | 页面提示的不支持节点数；旧节点不报告爬虫统计 |
