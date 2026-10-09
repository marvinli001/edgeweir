/**
 * The site detail tabs and the platform rules page: rules, bulk redirects, CRS, protection and
 * CC state, security events, error pages, sampled access logs, HTTPS and the CNAME target.
 * shop.example.com carries the most (it took the burst about 9.5 hours ago, answered with 403 /
 * 429); every other site answers with lighter data of its own. Ids: 10 rules, 11 deleted rules,
 * 15 security events.
 */
import {
  type AnalyticsRange,
  type BulkRedirect,
  CC_PRESETS,
  type CcThresholds,
  type CertificateDto,
  CHALLENGE_PRESETS,
  DEFAULT_COMPRESSION_TYPES,
  type HttpsCheck,
  type LogEntry,
  type LoggedRules,
  type RuleDto,
  type SecurityEvent,
  type Site,
  type SiteAuthRules,
  type SiteErrorPages,
  type SiteMaintenance,
  type SiteProtection,
  type SiteSecurityState,
  type SiteWaf,
  type TlsSettings,
  WAF_DEFAULTS,
  WAF_PRESETS,
  type WafTopRules,
} from "@edgeweir/contract";
import { ccTemplate, certificates, siteCertificateId } from "./access";
import { type Fixtures, notFound } from "./define";
import { infraFixtures } from "./infra";
import { trafficOf } from "./traffic";
import { ago, clusters, DAY, HOUR, id, MINUTE, NOW, nodes, noise, sites } from "./world";

function siteOf(siteId: string): Site {
  const site = sites.find((s) => s.id === siteId);
  if (!site) throw notFound();
  return site;
}

const indexOf = (site: Site) => sites.indexOf(site) + 1;
const SHOP = sites.find((s) => s.name === "shop.example.com") as Site;
const isShop = (site: Site) => site.id === SHOP.id;
const clusterNodes = (site: Site) => nodes.filter((n) => n.clusterId === site.clusterId);

/** The burst of traffic.ts: about 9.5 hours ago, 12 minutes wide. */
const SPIKE_AT = NOW - 9.5 * HOUR;
const SPIKE_SIGMA = 12 * MINUTE;
/** A small wave on /search a few minutes ago, which sin-edge-02 still answers with a challenge. */
const WAVE_AT = NOW - 6 * MINUTE;
const WAVE_SIGMA = 1.6 * MINUTE;

/** Addresses of the burst, heaviest first (the top IPs of traffic.ts). */
const ATTACKERS = [
  "203.0.113.77",
  "198.51.100.204",
  "192.0.2.18",
  "2001:db8:4f::2a",
  "198.51.100.9",
  "203.0.113.140",
];
const WAVE_IPS = ["2001:db8:91::7", "198.51.100.63"];

// ---------------------------------------------------------------------------------------------
// Rules

type Action = RuleDto["action"];
type RuleSeed = [name: string, phase: RuleDto["phase"], expression: string, action: Action];

const queryEdits = { target: "", setQuery: [], removeQuery: [] };

function rules(base: number, list: RuleSeed[], disabled: string[] = []): RuleDto[] {
  return list.map(([name, phase, expression, action], i) => ({
    id: id(10, base + i + 1),
    name,
    phase,
    expression,
    enabled: !disabled.includes(name),
    action,
  }));
}

const SHOP_RULES: RuleSeed[] = [
  [
    "Tracking parameters",
    "request-transform",
    'http.request.uri.query contains "utm_"',
    {
      kind: "rewrite",
      value: "",
      target: "http.request.uri.path",
      setQuery: [],
      removeQuery: ["utm_source", "utm_medium", "utm_campaign", "utm_content", "ref"],
      preserveQuery: true,
    },
  ],
  [
    "Status page alias",
    "request-transform",
    'http.request.uri.path eq "/status"',
    { kind: "rewrite", value: "/healthz", ...queryEdits, preserveQuery: false },
  ],
  [
    "Client country for the API",
    "request-transform",
    'starts_with(http.request.uri.path, "/api/")',
    {
      kind: "request_header",
      header: "x-client-country",
      value: "",
      expression: "ip.geoip.country",
      remove: false,
    },
  ],
  [
    "Blog moved",
    "redirect",
    'starts_with(http.request.uri.path, "/blog/")',
    {
      kind: "redirect",
      value: "",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: ${1} is the rule language's capture.
      target: 'wildcard_replace(http.request.uri.path, "/blog/*", "https://blog.example.org/${1}")',
      setQuery: [],
      removeQuery: [],
      statusCode: 301,
      preserveQuery: true,
    },
  ],
  [
    "Mobile host to main site",
    "redirect",
    'http.host eq "m.shop.example.com"',
    {
      kind: "redirect",
      value: "",
      target: 'concat("https://shop.example.com", http.request.uri.path)',
      setQuery: [],
      removeQuery: [],
      statusCode: 302,
      preserveQuery: true,
    },
  ],
  [
    "Sale landing page",
    "redirect",
    'http.request.uri.path in {"/sale" "/deals"}',
    {
      kind: "redirect",
      value: "/collections/summer",
      target: "",
      setQuery: [{ name: "utm_source", value: "edge", expression: "" }],
      removeQuery: [],
      statusCode: 302,
      preserveQuery: false,
    },
  ],
  [
    "Checkout under strict CC",
    "config",
    'starts_with(http.request.uri.path, "/checkout")',
    { kind: "config", ccEnabled: true, ccMaxLevel: "captcha", originReadTimeoutMs: 30_000 },
  ],
  [
    "Log every cart request",
    "config",
    'starts_with(http.request.uri.path, "/api/v2/cart")',
    { kind: "config", logSampleRate: 10_000 },
  ],
  [
    "Admin only from the office",
    "waf-custom",
    'starts_with(http.request.uri.path, "/admin") and not ip.src in {198.51.100.0/24 2001:db8:100::/48}',
    { kind: "block", statusCode: 403 },
  ],
  [
    "Partner API",
    "waf-custom",
    'starts_with(http.request.uri.path, "/api/") and ip.src in $api_partners',
    { kind: "allow" },
  ],
  [
    "Payment webhooks",
    "waf-custom",
    'http.request.uri.path eq "/api/v2/webhooks/payment" and not ip.src in $payment_webhooks',
    { kind: "block", statusCode: 403 },
  ],
  [
    "Cart writes",
    "waf-custom",
    'http.request.uri.path eq "/api/v2/cart" and http.request.method in {"POST" "PUT" "DELETE"}',
    { kind: "log" },
  ],
  [
    "Suspicious user agents",
    "waf-custom",
    'http.user_agent contains "sqlmap" or http.user_agent contains "nikto" or http.user_agent eq ""',
    { kind: "log" },
  ],
  [
    "Old app versions",
    "waf-custom",
    'http.request.headers["x-app-version"] wildcard "3.*"',
    { kind: "log" },
  ],
  [
    "Login from hosting networks",
    "waf-custom",
    'http.request.uri.path eq "/account/login" and ip.geoip.asnum in {64496 64511}',
    { kind: "challenge", type: "pow" },
  ],
  [
    "Retired API v1",
    "waf-custom",
    'starts_with(http.request.uri.path, "/api/v1/")',
    { kind: "block", statusCode: 403 },
  ],
  [
    "Login attempts",
    "ratelimit",
    'http.request.uri.path eq "/account/login" and http.request.method eq "POST"',
    { kind: "rate_limit", statusCode: 429, limit: 20, windowSeconds: 60, key: "ip.src" },
  ],
  [
    "Cart API",
    "ratelimit",
    'starts_with(http.request.uri.path, "/api/v2/cart")',
    { kind: "rate_limit", statusCode: 429, limit: 100, windowSeconds: 60, key: "ip.src" },
  ],
  [
    "Search per fingerprint",
    "ratelimit",
    'http.request.uri.path eq "/search"',
    { kind: "rate_limit", statusCode: 429, limit: 300, windowSeconds: 60, key: "tls.ja4" },
  ],
  [
    "Signed-in visitors",
    "cache",
    'http.request.cookies["session"] ne ""',
    { kind: "config", cacheBypass: true },
  ],
  [
    "Media from the media origins",
    "origin",
    'starts_with(http.request.uri.path, "/media/")',
    {
      kind: "origin",
      originGroup: "media",
      hostHeader: "origin-media.example.com",
      sni: "origin-media.example.com",
      port: 0,
    },
  ],
  [
    "No sniffing",
    "response-transform",
    "true",
    {
      kind: "response_header",
      header: "x-content-type-options",
      value: "nosniff",
      expression: "",
      remove: false,
      append: false,
    },
  ],
  [
    "Hide the framework",
    "response-transform",
    "true",
    {
      kind: "response_header",
      header: "x-powered-by",
      value: "",
      expression: "",
      remove: true,
      append: false,
    },
  ],
  [
    "Immutable assets",
    "response-transform",
    'starts_with(http.request.uri.path, "/assets/")',
    {
      kind: "response_header",
      header: "cache-control",
      value: "public, max-age=31536000, immutable",
      expression: "",
      remove: false,
      append: false,
    },
  ],
  [
    "Scripts and styles",
    "compression",
    'http.request.uri.path.extension in {"js" "css" "svg"}',
    { kind: "compression", algorithms: ["zstd", "br", "gzip"] },
  ],
  [
    "JSON",
    "compression",
    'http.response.content_type.media_type eq "application/json"',
    { kind: "compression", algorithms: ["br", "gzip"] },
  ],
];

const SITE_RULES: Record<string, { rules: RuleSeed[]; disabled?: string[] }> = {
  "shop.example.com": { rules: SHOP_RULES, disabled: ["Retired API v1"] },
  "example.com": {
    rules: [
      [
        "Apex to www",
        "redirect",
        'http.host eq "example.com"',
        {
          kind: "redirect",
          value: "",
          target: 'concat("https://www.example.com", http.request.uri.path)',
          setQuery: [],
          removeQuery: [],
          statusCode: 301,
          preserveQuery: true,
        },
      ],
      [
        "Contact form",
        "ratelimit",
        'http.request.uri.path eq "/contact" and http.request.method eq "POST"',
        { kind: "rate_limit", statusCode: 429, limit: 5, windowSeconds: 60, key: "ip.src" },
      ],
      [
        "Frame protection",
        "response-transform",
        "true",
        {
          kind: "response_header",
          header: "x-frame-options",
          value: "SAMEORIGIN",
          expression: "",
          remove: false,
          append: false,
        },
      ],
    ],
  },
  "api.example.com": {
    rules: [
      [
        "Token endpoint",
        "ratelimit",
        'http.request.uri.path eq "/v1/auth/token"',
        { kind: "rate_limit", statusCode: 429, limit: 30, windowSeconds: 60, key: "ip.src" },
      ],
      [
        "Per API key",
        "ratelimit",
        'starts_with(http.request.uri.path, "/v1/")',
        {
          kind: "rate_limit",
          statusCode: 429,
          limit: 6000,
          windowSeconds: 60,
          key: "http.request.headers.x-api-key",
        },
      ],
      [
        "Unversioned paths",
        "waf-custom",
        'not starts_with(http.request.uri.path, "/v1/") and http.request.uri.path ne "/healthz"',
        { kind: "block", statusCode: 403 },
      ],
      [
        "Batch endpoints",
        "waf-custom",
        'ends_with(http.request.uri.path, "/batch")',
        { kind: "log" },
      ],
    ],
  },
  "auth.example.net": {
    rules: [
      [
        "Sign-in attempts",
        "ratelimit",
        'http.request.uri.path in {"/login" "/oauth/token"} and http.request.method eq "POST"',
        { kind: "rate_limit", statusCode: 429, limit: 10, windowSeconds: 60, key: "ip.src" },
      ],
      [
        "Sign-in from hosting networks",
        "waf-custom",
        "ip.geoip.asnum in {64496 64497 64498}",
        { kind: "challenge", type: "captcha" },
      ],
    ],
  },
  "media.example.net": {
    rules: [
      [
        "Hotlinking",
        "waf-custom",
        'http.referer ne "" and not http.referer contains "example.net"',
        { kind: "block", statusCode: 403 },
      ],
    ],
  },
};

function siteRules(site: Site): RuleDto[] {
  const entry = SITE_RULES[site.name];
  return entry ? rules(indexOf(site) * 100, entry.rules, entry.disabled) : [];
}

const PLATFORM_RULE_SEEDS: RuleSeed[] = [
  [
    "Reserved networks",
    "waf-custom",
    "ip.src in {192.0.2.200/29 2001:db8:dead::/48}",
    { kind: "block", statusCode: 403 },
  ],
  ["Bad bots", "waf-custom", "ip.src in $bad_bots", { kind: "challenge", type: "pow" }],
  [
    "Scanner fingerprints",
    "waf-custom",
    'tls.ja4 in {"t13d190900_9dc949149365_97f8aa674fd9" "t13d311100_e8f1e7e78f70_d339722ba4af"}',
    { kind: "log" },
  ],
  [
    "CMS probes",
    "waf-custom",
    'http.request.uri.path wildcard "/wp-*" or http.request.uri.path.extension eq "php"',
    { kind: "log" },
  ],
  ["Empty user agents", "waf-custom", 'http.user_agent eq ""', { kind: "challenge", type: "js" }],
  [
    "Hosting networks",
    "waf-custom",
    "ip.geoip.asnum in {64496 64497 64498}",
    { kind: "block", statusCode: 403 },
  ],
  [
    "Per-address ceiling",
    "ratelimit",
    "true",
    { kind: "rate_limit", statusCode: 429, limit: 1200, windowSeconds: 60, key: "ip.src" },
  ],
  [
    "Fewer static asset logs",
    "config",
    'http.request.uri.path.extension in {"css" "js" "png" "webp" "woff2"}',
    { kind: "config", logSampleRate: 100 },
  ],
  [
    "Edge request id",
    "response-transform",
    "true",
    {
      kind: "response_header",
      header: "x-edge-request",
      value: "",
      expression: "http.request.id",
      remove: false,
      append: false,
    },
  ],
];

const PLATFORM_BASE = 0x1000;
const platformRuleList = rules(PLATFORM_BASE, PLATFORM_RULE_SEEDS, ["Hosting networks"]);

// ---------------------------------------------------------------------------------------------
// Match counts over a range (rules with the log action, CRS rules)

/** Requests of the site over the range and the share answered 4xx (mostly the burst). */
function volume(range: AnalyticsRange, siteId: string) {
  const t = trafficOf(range, siteId).totals;
  return { requests: t.requests, refused: t.status4xx };
}

const count = (v: { requests: number; refused: number }, normal: number, attack: number) =>
  Math.round(v.requests * normal + v.refused * attack);

function topLogged(site: Site, range: AnalyticsRange, limit: number): LoggedRules {
  const v = volume(range, site.id);
  const own = siteRules(site).filter((r) => r.action.kind === "log");
  const weights: Record<string, [number, number]> = {
    "Cart writes": [0.0042, 0.58],
    "Suspicious user agents": [0.0003, 0.07],
    "Old app versions": [0.0021, 0],
    "Batch endpoints": [0.0012, 0.01],
  };
  const platformLog = platformRuleList.filter((r) => r.action.kind === "log");
  const platformWeights: Record<string, [number, number]> = {
    "Scanner fingerprints": [0.00008, isShop(site) ? 0.31 : 0.02],
    "CMS probes": [0.0006, 0.01],
  };
  const items = [
    ...own.map((r) => {
      const [normal, attack] = weights[r.name] ?? [0.001, 0];
      return { ruleId: r.id, name: r.name, platform: false, requests: count(v, normal, attack) };
    }),
    ...platformLog.map((r) => {
      const [normal, attack] = platformWeights[r.name] ?? [0.0002, 0];
      return { ruleId: r.id, name: r.name, platform: true, requests: count(v, normal, attack) };
    }),
    // A rule deleted since it matched.
    ...(isShop(site)
      ? [{ ruleId: id(11, 1), name: null, platform: false, requests: count(v, 0.00011, 0) }]
      : []),
  ]
    .filter((item) => item.requests > 0)
    .sort((a, b) => b.requests - a.requests)
    .slice(0, limit);
  return { approximate: true, items, unsupportedNodes: 0 };
}

/** CRS rules that match, with their share of normal and of refused requests. */
const CRS_MATCHES: [ruleId: number, normal: number, attack: number][] = [
  [942100, 0.00004, 0.17],
  [942200, 0.00001, 0.061],
  [913100, 0.0001, 0.048],
  [941100, 0.00002, 0.036],
  [920350, 0.00052, 0],
  [930120, 0.00003, 0.019],
  [920320, 0.00028, 0.009],
  [932160, 0.00001, 0.014],
  [920440, 0.00019, 0],
  [921110, 0.000004, 0.003],
  [920420, 0.00008, 0],
  [933160, 0.000006, 0.002],
];

function wafTopRules(site: Site, range: AnalyticsRange, limit: number): WafTopRules {
  const waf = wafOf(site);
  if (waf.mode === "off") return { approximate: true, items: [] };
  const v = volume(range, site.id);
  const items = CRS_MATCHES.filter(([ruleId]) => !waf.excludedRuleIds.includes(ruleId))
    .map(([ruleId, normal, attack]) => ({
      ruleId,
      requests: count(v, normal * (waf.paranoiaLevel > 1 ? 1.8 : 1), attack),
    }))
    .filter((item) => item.requests > 0)
    .sort((a, b) => b.requests - a.requests)
    .slice(0, limit);
  return { approximate: true, items };
}

// ---------------------------------------------------------------------------------------------
// CRS and protection

function wafOf(site: Site): SiteWaf {
  const base = { siteId: site.id, ...WAF_DEFAULTS, excludedRuleIds: [], updatedAt: null };
  switch (site.name) {
    case "shop.example.com":
      return {
        ...base,
        mode: "block",
        ...WAF_PRESETS.standard,
        excludedRuleIds: [920300, 942430],
        updatedAt: ago(9 * HOUR),
      };
    case "example.com":
      return { ...base, mode: "block", ...WAF_PRESETS.standard, updatedAt: ago(41 * DAY) };
    case "api.example.com":
      return {
        ...base,
        mode: "detect",
        ...WAF_PRESETS.strict,
        excludedRuleIds: [920420],
        updatedAt: ago(12 * DAY),
      };
    case "auth.example.net":
      return {
        ...base,
        mode: "block",
        paranoiaLevel: 2,
        anomalyThreshold: 7,
        requestBodyLimit: 131_072,
        updatedAt: ago(20 * DAY),
      };
    case "docs.example.org":
      return { ...base, mode: "detect", ...WAF_PRESETS.loose, updatedAt: ago(60 * DAY) };
    default:
      return base;
  }
}

const withCc = (thresholds: CcThresholds, enabled: boolean, followTemplate: boolean) => ({
  ...thresholds,
  enabled,
  followTemplate,
});

function protectionOf(site: Site): SiteProtection {
  const template = ccTemplate;
  const base: SiteProtection = {
    siteId: site.id,
    underAttack: false,
    underAttackChallenge: "js",
    ...CHALLENGE_PRESETS.standard,
    cc: withCc(template, false, true),
    ccTemplate: template,
    effectiveCc: null,
    logJa4: false,
    platformUnderAttack: false,
    updatedAt: null,
  };
  switch (site.name) {
    case "shop.example.com":
      return {
        ...base,
        cc: withCc(CC_PRESETS.strict, true, false),
        effectiveCc: CC_PRESETS.strict,
        logJa4: true,
        updatedAt: ago(9 * HOUR),
      };
    case "example.com":
    case "static.example.net":
    case "docs.example.org":
      return {
        ...base,
        cc: withCc(template, true, true),
        effectiveCc: template,
        updatedAt: ago(30 * DAY),
      };
    case "api.example.com":
      return {
        ...base,
        underAttackChallenge: "pow",
        cc: withCc(CC_PRESETS.loose, true, false),
        effectiveCc: CC_PRESETS.loose,
        logJa4: true,
        updatedAt: ago(12 * DAY),
      };
    case "auth.example.net":
      return {
        ...base,
        underAttack: true,
        underAttackChallenge: "pow",
        ...CHALLENGE_PRESETS.strict,
        cc: withCc(CC_PRESETS.strict, true, false),
        effectiveCc: CC_PRESETS.strict,
        logJa4: true,
        updatedAt: ago(13 * HOUR),
      };
    default:
      return base;
  }
}

// ---------------------------------------------------------------------------------------------
// CC state and security events

type Top = { value: string; count: number };

/** Heaviest addresses and paths of the events in the last `hours`. */
function topsOf(site: Site, hours: number): { topIps: Top[]; topPaths: Top[] } {
  if (!isShop(site)) {
    if (site.name !== "api.example.com" || hours < 24) return { topIps: [], topPaths: [] };
    return {
      topIps: [
        { value: "198.51.100.177", count: 18_420 },
        { value: "2001:db8:6d::c4", count: 6_310 },
      ],
      topPaths: [{ value: "/v1/auth/token", count: 24_730 }],
    };
  }
  const wave: Top[] = [
    { value: "2001:db8:91::7", count: 2_140 },
    { value: "198.51.100.63", count: 610 },
  ];
  const wavePaths: Top[] = [{ value: "/search", count: 2_480 }];
  if (hours < 9) return { topIps: wave, topPaths: wavePaths };
  const scale = hours >= 168 ? 1.12 : 1;
  const weights = [1, 0.58, 0.33, 0.27, 0.21, 0.17];
  const burstIps = ATTACKERS.map((value, i) => ({
    value,
    count: Math.round(412_000 * (weights[i] ?? 0.1) * scale),
  }));
  const older: Top[] = hours >= 168 ? [{ value: "192.0.2.201", count: 9_870 }] : [];
  return {
    topIps: [...burstIps, ...older, ...wave].sort((a, b) => b.count - a.count).slice(0, 10),
    topPaths: [
      { value: "/api/v2/cart", count: Math.round(689_000 * scale) },
      { value: "/account/login", count: Math.round(381_000 * scale) },
      { value: "/api/v2/cart/items", count: Math.round(57_400 * scale) },
      ...wavePaths,
      ...(hours >= 168 ? [{ value: "/collections/summer", count: 1_930 }] : []),
      { value: "/", count: 1_210 },
    ],
  };
}

function securityState(site: Site, hours: number): SiteSecurityState {
  const list = clusterNodes(site).filter((n) => n.status === "active");
  return {
    nodes: list.map((n, i) => {
      const raised = isShop(site) && n.name === "sin-edge-02";
      return {
        id: n.id,
        name: n.name,
        online: n.online,
        level: raised && n.online ? "cookie302" : "normal",
        escalatedPaths: isShop(site) && n.name === "tyo-edge-01" ? 1 : 0,
        reportedAt: n.online ? ago(5_000 + i * 2_300) : n.lastSeenAt,
      };
    }),
    ...topsOf(site, hours),
    hours,
  };
}

interface EventSeed {
  at: number;
  node: string;
  kind: SecurityEvent["kind"];
  level?: string;
  previous?: string;
  path?: string;
  address?: string;
  metric: string;
  observed: number;
  threshold: number;
  topIps?: Top[];
  topPaths?: Top[];
}

const LEVELS = ["normal", "cookie302", "js", "pow", "captcha"];
const burstTopIps = (scale: number): Top[] =>
  ATTACKERS.slice(0, 4).map((value, i) => ({
    value,
    count: Math.round(([5_400, 3_100, 1_800, 1_450][i] ?? 900) * scale),
  }));
const burstTopPaths = (scale: number): Top[] => [
  { value: "/api/v2/cart", count: Math.round(8_900 * scale) },
  { value: "/account/login", count: Math.round(4_700 * scale) },
];

/** shop.example.com: the burst, an origin failure yesterday, a wave three days ago and now. */
function shopEventSeeds(): EventSeed[] {
  const out: EventSeed[] = [];
  const start = SPIKE_AT - 24 * MINUTE;
  const apac = ["tyo-edge-01", "tyo-edge-02", "sin-edge-01", "sin-edge-02"];
  const strict = CC_PRESETS.strict;
  apac.forEach((node, n) => {
    // Escalation: the busiest nodes reach captcha, the others stop at proof of work.
    const top = n % 2 === 0 ? 4 : 3;
    const steps = [0, 2.5, 6, 11].map((m) => start + m * MINUTE + n * 9_000);
    for (let level = 1; level <= top; level++) {
      const scale = 0.6 + level * 0.25;
      out.push({
        at: steps[level - 1] as number,
        node,
        kind: "site_level",
        level: LEVELS[level],
        previous: LEVELS[level - 1],
        metric: "site_qps",
        observed: Math.round(strict.siteQps * (2.8 + level * 1.7 + noise(n * 11 + level) * 1.2)),
        threshold: strict.siteQps,
        topIps: burstTopIps(scale),
        topPaths: burstTopPaths(scale),
      });
    }
    // Cooldown, one level per cooldown period once the burst is over.
    const calm = SPIKE_AT + 31 * MINUTE + n * 23_000;
    for (let level = top; level >= 1; level--) {
      out.push({
        at: calm + (top - level) * (strict.cooldownSeconds * 1000 + 4_000),
        node,
        kind: "site_level",
        level: LEVELS[level - 1],
        previous: LEVELS[level],
        metric: "cooldown",
        observed: strict.cooldownSeconds,
        threshold: strict.cooldownSeconds,
      });
    }
  });
  // Paths the burst concentrated on, escalated above the site's level.
  const paths: [string, string, string, number][] = [
    ["tyo-edge-01", "/api/v2/cart", "js", 7.5],
    ["sin-edge-01", "/api/v2/cart", "js", 8.2],
    ["tyo-edge-01", "/account/login", "pow", 9.1],
    ["tyo-edge-02", "/account/login", "pow", 9.6],
  ];
  for (const [node, path, level, minute] of paths) {
    out.push({
      at: start + minute * MINUTE,
      node,
      kind: "path_level",
      level,
      previous: "normal",
      path,
      metric: "url_qps",
      observed: Math.round(strict.urlQps * (9 + noise(minute * 100) * 6)),
      threshold: strict.urlQps,
      topIps: burstTopIps(0.4),
      topPaths: [{ value: path, count: Math.round(3_200 + noise(minute * 7) * 2_000) }],
    });
    out.push({
      at: SPIKE_AT + 27 * MINUTE + minute * 20_000,
      node,
      kind: "path_level",
      level: "normal",
      previous: level,
      path,
      metric: "cooldown",
      observed: strict.cooldownSeconds,
      threshold: strict.cooldownSeconds,
    });
  }
  // Addresses over the per-address rate, banned for an hour.
  ATTACKERS.forEach((address, i) => {
    for (const node of i < 2 ? ["tyo-edge-01", "sin-edge-01"] : [apac[i % 4] as string]) {
      out.push({
        at: start + (1.2 + i * 1.7) * MINUTE + (node === "sin-edge-01" ? 14_000 : 0),
        node,
        kind: "ip_banned",
        address,
        metric: "ip_qps",
        observed: Math.round(strict.ipQps * (6 + noise(i * 31) * 14)),
        threshold: strict.ipQps,
        topPaths: [{ value: i % 2 ? "/account/login" : "/api/v2/cart", count: 2_000 + i * 310 }],
      });
    }
  });
  // Yesterday: origin 198.51.100.11 failed for a while.
  const failure = NOW - 26 * HOUR;
  out.push(
    {
      at: failure,
      node: "tyo-edge-02",
      kind: "site_level",
      level: "cookie302",
      previous: "normal",
      metric: "origin_error_rate",
      observed: 64,
      threshold: strict.originErrorPercent,
      topPaths: [
        { value: "/api/v2/products", count: 1_840 },
        { value: "/checkout", count: 320 },
      ],
    },
    {
      at: failure + 13 * MINUTE,
      node: "tyo-edge-02",
      kind: "site_level",
      level: "normal",
      previous: "cookie302",
      metric: "cooldown",
      observed: strict.cooldownSeconds,
      threshold: strict.cooldownSeconds,
    },
  );
  // Three days ago: a short wave from one address.
  const wave = NOW - 3 * DAY - 4 * HOUR;
  out.push(
    {
      at: wave,
      node: "sin-edge-01",
      kind: "ip_banned",
      address: "192.0.2.201",
      metric: "ip_qps",
      observed: 214,
      threshold: strict.ipQps,
      topPaths: [{ value: "/collections/summer", count: 1_930 }],
    },
    {
      at: wave + 40_000,
      node: "sin-edge-01",
      kind: "path_level",
      level: "cookie302",
      previous: "normal",
      path: "/collections/summer",
      metric: "url_qps",
      observed: 188,
      threshold: strict.urlQps,
      topIps: [{ value: "192.0.2.201", count: 1_620 }],
      topPaths: [{ value: "/collections/summer", count: 1_930 }],
    },
    {
      at: wave + 9 * MINUTE,
      node: "sin-edge-01",
      kind: "path_level",
      level: "normal",
      previous: "cookie302",
      path: "/collections/summer",
      metric: "cooldown",
      observed: strict.cooldownSeconds,
      threshold: strict.cooldownSeconds,
    },
  );
  // Now: the /search wave; sin-edge-02 still challenges.
  out.push(
    {
      at: WAVE_AT - 40_000,
      node: "sin-edge-02",
      kind: "ip_banned",
      address: "2001:db8:91::7",
      metric: "ip_qps",
      observed: 96,
      threshold: strict.ipQps,
      topPaths: [{ value: "/search", count: 1_420 }],
    },
    {
      at: WAVE_AT,
      node: "sin-edge-02",
      kind: "site_level",
      level: "cookie302",
      previous: "normal",
      metric: "site_qps",
      observed: 348,
      threshold: strict.siteQps,
      topIps: [
        { value: "2001:db8:91::7", count: 2_140 },
        { value: "198.51.100.63", count: 610 },
      ],
      topPaths: [{ value: "/search", count: 2_480 }],
    },
    {
      at: WAVE_AT + 50_000,
      node: "tyo-edge-01",
      kind: "path_level",
      level: "cookie302",
      previous: "normal",
      path: "/search",
      metric: "url_qps",
      observed: 77,
      threshold: strict.urlQps,
      topIps: [{ value: "198.51.100.63", count: 610 }],
      topPaths: [{ value: "/search", count: 980 }],
    },
  );
  return out;
}

const OTHER_EVENT_SEEDS: Record<string, EventSeed[]> = {
  "api.example.com": [
    {
      at: NOW - 15 * HOUR,
      node: "iad-edge-02",
      kind: "path_level",
      level: "js",
      previous: "normal",
      path: "/v1/auth/token",
      metric: "url_qps",
      observed: 1_920,
      threshold: CC_PRESETS.loose.urlQps,
      topIps: [
        { value: "198.51.100.177", count: 18_420 },
        { value: "2001:db8:6d::c4", count: 6_310 },
      ],
      topPaths: [{ value: "/v1/auth/token", count: 24_730 }],
    },
    {
      at: NOW - 15 * HOUR + 2 * MINUTE,
      node: "iad-edge-02",
      kind: "ip_banned",
      address: "198.51.100.177",
      metric: "ip_qps",
      observed: 410,
      threshold: CC_PRESETS.loose.ipQps,
      topPaths: [{ value: "/v1/auth/token", count: 18_420 }],
    },
    {
      at: NOW - 14 * HOUR,
      node: "iad-edge-02",
      kind: "path_level",
      level: "normal",
      previous: "js",
      path: "/v1/auth/token",
      metric: "cooldown",
      observed: CC_PRESETS.loose.cooldownSeconds,
      threshold: CC_PRESETS.loose.cooldownSeconds,
    },
  ],
  "example.com": [
    {
      at: NOW - 2 * DAY - 7 * HOUR,
      node: "tyo-edge-02",
      kind: "ip_banned",
      address: "203.0.113.5",
      metric: "ip_qps",
      observed: 61,
      threshold: ccTemplate.ipQps,
      topPaths: [{ value: "/", count: 640 }],
    },
  ],
};

function eventsOf(site: Site): SecurityEvent[] {
  const seeds = isShop(site) ? shopEventSeeds() : (OTHER_EVENT_SEEDS[site.name] ?? []);
  const base = indexOf(site) * 1000;
  return seeds
    .filter((seed) => seed.at <= NOW)
    .sort((a, b) => b.at - a.at)
    .map((seed, i) => {
      const node = nodes.find((n) => n.name === seed.node);
      return {
        id: id(15, base + i + 1),
        node: node ? { id: node.id, name: node.name } : null,
        occurredAt: new Date(seed.at).toISOString(),
        kind: seed.kind,
        level: seed.level ?? "",
        previousLevel: seed.previous ?? "",
        path: seed.path ?? "",
        address: seed.address ?? "",
        metric: seed.metric,
        observed: seed.observed,
        threshold: seed.threshold,
        topIps: seed.topIps ?? [],
        topPaths: seed.topPaths ?? [],
      };
    });
}

const eventCache = new Map<string, SecurityEvent[]>();
const cachedEvents = (site: Site) => {
  let list = eventCache.get(site.id);
  if (!list) {
    list = eventsOf(site);
    eventCache.set(site.id, list);
  }
  return list;
};

// ---------------------------------------------------------------------------------------------
// Bulk redirects

const PRODUCTS = [
  "linen-shirt-white",
  "linen-shirt-sage",
  "canvas-tote-olive",
  "canvas-tote-sand",
  "wool-scarf-grey",
  "wool-scarf-rust",
  "ceramic-mug-sand",
  "ceramic-mug-ink",
  "leather-wallet-brown",
  "leather-belt-black",
  "cotton-tee-navy",
  "cotton-tee-white",
  "denim-jacket-indigo",
  "rain-shell-moss",
  "knit-beanie-oat",
  "silk-scarf-coral",
  "travel-kit-charcoal",
  "notebook-a5-dotted",
  "candle-cedar",
  "candle-fig",
  "throw-blanket-stone",
  "pillow-cover-clay",
  "sunglasses-tortoise",
  "watch-strap-tan",
  "gift-card",
  "socks-merino-grey",
  "socks-merino-navy",
  "apron-canvas-ochre",
  "tea-towel-stripe",
  "water-bottle-steel",
  "bucket-hat-khaki",
  "sneaker-court-white",
  "sandal-slide-black",
  "umbrella-compact-ink",
  "backpack-roll-top",
  "pouch-zip-small",
];

function shopRedirects(): BulkRedirect[] {
  const fixed: [string, string, BulkRedirect["statusCode"], boolean?][] = [
    ["/summer-sale", "/collections/summer", 301],
    ["/new", "/collections/new-in", 301],
    ["/shop/new-arrivals", "/collections/new-in", 301],
    ["/shop/all", "/collections/all", 301],
    ["/help", "https://docs.example.org/shop/help", 302],
    ["/returns", "https://docs.example.org/shop/returns", 301],
    ["/shipping", "https://docs.example.org/shop/shipping", 301],
    ["/contact-us", "/pages/contact", 301],
    ["/about-us", "/pages/about", 301],
    ["/stores", "/pages/stores", 301],
    ["/blog", "https://blog.example.org/", 301],
    ["/careers", "https://example.com/careers", 308],
    ["/gift-cards", "/products/gift-card", 301],
    ["/cart.php", "/cart", 301, true],
    ["/checkout.php", "/checkout", 301, true],
    ["/index.php", "/", 301],
    ["/account/orders.php", "/account/orders", 301, true],
    ["/wishlist", "/account/wishlist", 302],
    ["/black-friday", "/collections/sale", 307],
    ["m.shop.example.com/", "https://shop.example.com/", 302, true],
    ["m.shop.example.com/app", "https://shop.example.com/pages/app", 302],
    ["m.shop.example.com/cart", "https://shop.example.com/cart", 302, true],
  ];
  const categories: [string, string][] = [
    ["/catalog/category/view/id/12", "/collections/shirts"],
    ["/catalog/category/view/id/14", "/collections/bags"],
    ["/catalog/category/view/id/17", "/collections/accessories"],
    ["/catalog/category/view/id/21", "/collections/home"],
  ];
  const products = PRODUCTS.map((slug, i): [string, string] => [
    `/catalog/product/view/id/${1043 + i * 7}`,
    `/products/${slug}`,
  ]);
  return [
    ...fixed.map(([source, target, statusCode, preserveQuery]) => ({
      source,
      target,
      statusCode,
      preserveQuery: preserveQuery ?? false,
    })),
    ...[...categories, ...products].map(([source, target]) => ({
      source,
      target,
      statusCode: 301 as const,
      preserveQuery: false,
    })),
  ];
}

function redirectsOf(site: Site): BulkRedirect[] {
  if (isShop(site)) return shopRedirects();
  if (site.name === "example.com")
    return [
      { source: "/press", target: "/news", statusCode: 301, preserveQuery: false },
      { source: "/jobs", target: "/careers", statusCode: 301, preserveQuery: false },
      {
        source: "/docs",
        target: "https://docs.example.org/",
        statusCode: 302,
        preserveQuery: true,
      },
    ];
  if (site.name === "docs.example.org")
    return [
      { source: "/v1/", target: "/archive/v1/", statusCode: 301, preserveQuery: false },
      {
        source: "/getting-started.html",
        target: "/start/",
        statusCode: 308,
        preserveQuery: false,
      },
    ];
  return [];
}

// ---------------------------------------------------------------------------------------------
// Error pages

const page = (status: number, title: string, text: string, extra = "") => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · Shop</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center;
      font: 16px/1.6 system-ui, sans-serif; background: #f7f4ef; color: #2a2521; }
    main { max-width: 32rem; padding: 2rem; }
    .code { font-size: 3rem; font-weight: 700; margin: 0; color: #b4552d; }
    .meta { font-size: 0.8rem; color: #8a817a; }
  </style>
</head>
<body>
  <main>
    <p class="code">{{status}}</p>
    <h1>${title}</h1>
    <p>${text}</p>${extra}
    <p class="meta">Request {{request_id}} · {{client_ip}}${status === 403 ? " · {{time}}" : ""}</p>
  </main>
</body>
</html>
`;

function errorPagesOf(site: Site): SiteErrorPages {
  if (isShop(site))
    return {
      siteId: site.id,
      pages: [
        {
          status: 403,
          template: page(
            403,
            "Access denied",
            "This request was blocked. If you think this is a mistake, contact support with the request id below.",
          ),
          redirectUrl: "",
          responseStatus: 0,
        },
        // Retired product URLs go to the search page.
        {
          status: 410,
          template: "",
          redirectUrl: "/search?gone={{request_id}}",
          responseStatus: 0,
        },
        {
          status: 429,
          template: page(
            429,
            "Slow down a little",
            "Too many requests came from your network. Please wait a minute and try again.",
          ),
          redirectUrl: "",
          responseStatus: 0,
        },
        {
          status: 502,
          template: page(
            502,
            "We'll be right back",
            "The shop is not answering right now. Your cart is saved.",
            '\n    <p><a href="/">Try again</a></p>',
          ),
          redirectUrl: "",
          responseStatus: 0,
        },
        {
          status: 503,
          template: page(
            503,
            "Down for maintenance",
            "We are updating the shop and will be back shortly.",
          ),
          redirectUrl: "",
          responseStatus: 0,
        },
        // Every other server error: the 502 page's words, sent as 503 so crawlers come back.
        {
          status: "5xx",
          template: page(
            500,
            "Something went wrong",
            "We could not finish this request. Your cart is saved.",
            '\n    <p><a href="/">Back to the shop</a></p>',
          ),
          redirectUrl: "",
          responseStatus: 503,
        },
      ],
      interceptOriginErrors: true,
      updatedAt: ago(12 * DAY),
    };
  if (site.name === "example.com")
    return {
      siteId: site.id,
      pages: [
        {
          status: 502,
          template:
            "<!doctype html>\n<title>{{status}}</title>\n<h1>Temporarily unavailable</h1>\n<p>{{host}} · {{request_id}}</p>\n",
          redirectUrl: "",
          responseStatus: 0,
        },
      ],
      interceptOriginErrors: false,
      updatedAt: ago(40 * DAY),
    };
  return { siteId: site.id, pages: [], interceptOriginErrors: false, updatedAt: null };
}

/**
 * Maintenance mode: the shop keeps its settings for the next release window (off now; the office
 * network and the payment provider's callbacks pass); other sites never set it.
 */
/** The shop protects its admin area with Basic and its videos with signed URLs. */
function authRulesOf(site: Site): SiteAuthRules {
  const scope = { domains: [], pathPrefixes: [], extensions: [], excludePathPrefixes: [] };
  if (!isShop(site)) return { siteId: site.id, rules: [], updatedAt: null };
  return {
    siteId: site.id,
    rules: [
      {
        id: id(0xa12, 1),
        kind: "basic",
        enabled: true,
        scope: { ...scope, pathPrefixes: ["/admin/"] },
        basic: {
          realm: site.name,
          keepAuthorization: false,
          userHeader: true,
          users: [{ name: "ops" }, { name: "auditor" }],
        },
        forward: null,
        url: null,
      },
      {
        id: id(0xa12, 2),
        kind: "url_b",
        enabled: true,
        scope: {
          ...scope,
          extensions: ["mp4", "m3u8"],
          excludePathPrefixes: ["/videos/trailers/"],
        },
        basic: null,
        forward: null,
        url: {
          validitySeconds: 1800,
          skewSeconds: 300,
          signParam: "sign",
          timeParam: "t",
          backupKey: true,
        },
      },
    ],
    updatedAt: ago(4 * DAY),
  };
}

function maintenanceOf(site: Site): SiteMaintenance {
  if (isShop(site))
    return {
      siteId: site.id,
      enabled: false,
      template: page(
        503,
        "Down for maintenance",
        "We are updating the shop and will be back within the hour. Your cart is saved.",
      ),
      retryAfterSeconds: 1800,
      allowedCidrs: ["198.51.100.0/24", "2001:db8:a:100::/56"],
      allowedPathPrefixes: ["/api/v2/payments/callback", "/healthz"],
      updatedAt: ago(9 * DAY),
    };
  return {
    siteId: site.id,
    enabled: false,
    template: "",
    retryAfterSeconds: 0,
    allowedCidrs: [],
    allowedPathPrefixes: [],
    updatedAt: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Access logs

type Kind = "asset" | "page" | "api" | "cart" | "login" | "redirect" | "missing" | "media";
interface PathSeed {
  path: string;
  kind: Kind;
  bytes: number;
  weight: number;
  host?: string;
  /** The status of a redirect (301 unless set). */
  status?: number;
}

const SHOP_PATHS: PathSeed[] = [
  { path: "/", kind: "page", bytes: 38_400, weight: 10 },
  { path: "/collections/summer", kind: "page", bytes: 44_100, weight: 4 },
  { path: "/collections/new-in", kind: "page", bytes: 41_300, weight: 3 },
  { path: "/products/linen-shirt-white", kind: "page", bytes: 52_600, weight: 4 },
  { path: "/products/canvas-tote-olive", kind: "page", bytes: 49_200, weight: 3 },
  { path: "/products/wool-scarf-grey", kind: "page", bytes: 47_800, weight: 2 },
  { path: "/products/ceramic-mug-sand", kind: "page", bytes: 45_900, weight: 2 },
  { path: "/search", kind: "page", bytes: 36_200, weight: 2 },
  { path: "/assets/app-3f9c1a.js", kind: "asset", bytes: 182_400, weight: 9 },
  { path: "/assets/app-3f9c1a.css", kind: "asset", bytes: 64_100, weight: 8 },
  { path: "/images/hero@2x.webp", kind: "asset", bytes: 248_300, weight: 6 },
  { path: "/images/products/linen-shirt-white-800.webp", kind: "asset", bytes: 86_200, weight: 5 },
  { path: "/images/products/canvas-tote-olive-800.webp", kind: "asset", bytes: 79_400, weight: 4 },
  { path: "/fonts/inter-var.woff2", kind: "asset", bytes: 98_100, weight: 4 },
  { path: "/favicon.ico", kind: "asset", bytes: 4_286, weight: 2 },
  { path: "/robots.txt", kind: "asset", bytes: 312, weight: 0.6 },
  { path: "/sitemap.xml", kind: "page", bytes: 12_480, weight: 0.6 },
  { path: "/api/v2/products", kind: "api", bytes: 6_420, weight: 7 },
  { path: "/api/v2/cart", kind: "cart", bytes: 2_140, weight: 4 },
  { path: "/api/v2/cart/items", kind: "cart", bytes: 1_830, weight: 2 },
  { path: "/checkout", kind: "cart", bytes: 31_200, weight: 1.5 },
  { path: "/account/login", kind: "login", bytes: 18_300, weight: 2 },
  { path: "/sale", kind: "redirect", bytes: 162, weight: 0.8, status: 302 },
  { path: "/blog/spring-lookbook", kind: "redirect", bytes: 162, weight: 0.4 },
  { path: "/catalog/product/view/id/1057", kind: "redirect", bytes: 162, weight: 0.3 },
  { path: "/products/linen-shirt-blue", kind: "missing", bytes: 9_800, weight: 0.5 },
  { path: "/media/lookbook-2026.mp4", kind: "media", bytes: 4_812_000, weight: 0.5 },
];

const API_PATHS: PathSeed[] = [
  { path: "/v1/catalog/items", kind: "api", bytes: 7_900, weight: 8 },
  { path: "/v1/catalog/categories", kind: "api", bytes: 2_300, weight: 3 },
  { path: "/v1/orders", kind: "cart", bytes: 3_100, weight: 3 },
  { path: "/v1/users/me", kind: "cart", bytes: 1_200, weight: 4 },
  { path: "/v1/auth/token", kind: "login", bytes: 820, weight: 3 },
  { path: "/v1/events/batch", kind: "cart", bytes: 140, weight: 2 },
  { path: "/healthz", kind: "api", bytes: 16, weight: 1 },
  { path: "/v2/items", kind: "missing", bytes: 120, weight: 0.3 },
];

const ASSET_PATHS: PathSeed[] = [
  { path: "/img/banner-1920.avif", kind: "asset", bytes: 212_000, weight: 5 },
  { path: "/img/logo.svg", kind: "asset", bytes: 3_400, weight: 6 },
  { path: "/js/vendor-91c2d0.js", kind: "asset", bytes: 341_000, weight: 4 },
  { path: "/css/site-1a7e44.css", kind: "asset", bytes: 48_000, weight: 4 },
  { path: "/fonts/source-sans.woff2", kind: "asset", bytes: 72_000, weight: 3 },
  { path: "/video/intro-720p.mp4", kind: "media", bytes: 9_400_000, weight: 1 },
  { path: "/img/missing-thumb.webp", kind: "missing", bytes: 120, weight: 0.4 },
];

const MEDIA_PATHS: PathSeed[] = [
  { path: "/live/stream-a/index.m3u8", kind: "api", bytes: 1_100, weight: 6 },
  { path: "/live/stream-a/seg-48211.m4s", kind: "media", bytes: 1_840_000, weight: 9 },
  { path: "/vod/keynote/1080p.mp4", kind: "media", bytes: 48_000_000, weight: 3 },
  { path: "/vod/keynote/poster.jpg", kind: "asset", bytes: 182_000, weight: 2 },
];

const DOWNLOAD_PATHS: PathSeed[] = [
  { path: "/releases/v4.2.0/tool-linux-amd64.tar.gz", kind: "media", bytes: 38_400_000, weight: 6 },
  {
    path: "/releases/v4.2.0/tool-darwin-arm64.tar.gz",
    kind: "media",
    bytes: 36_900_000,
    weight: 4,
  },
  { path: "/releases/v4.2.0/checksums.txt", kind: "asset", bytes: 1_240, weight: 3 },
  { path: "/releases/latest", kind: "redirect", bytes: 160, weight: 2, status: 302 },
];

const WEB_PATHS: PathSeed[] = [
  { path: "/", kind: "page", bytes: 31_000, weight: 8 },
  { path: "/start/", kind: "page", bytes: 28_000, weight: 4 },
  { path: "/guides/configuration/", kind: "page", bytes: 42_000, weight: 3 },
  { path: "/assets/main-5d2a.css", kind: "asset", bytes: 38_000, weight: 6 },
  { path: "/assets/main-5d2a.js", kind: "asset", bytes: 121_000, weight: 6 },
  { path: "/images/cover.webp", kind: "asset", bytes: 96_000, weight: 3 },
  { path: "/feed.xml", kind: "page", bytes: 18_000, weight: 1 },
  { path: "/old-page.html", kind: "missing", bytes: 7_400, weight: 0.4 },
];

function profileOf(site: Site): PathSeed[] {
  if (isShop(site))
    return [
      ...SHOP_PATHS,
      // Old links to the mobile host, which a redirect rule sends to the main site.
      ...SHOP_PATHS.filter((p) => p.kind === "page")
        .slice(0, 5)
        .map((p) => ({
          ...p,
          kind: "redirect" as const,
          host: "m.shop.example.com",
          bytes: 162,
          weight: p.weight * 0.12,
          status: 302,
        })),
    ];
  if (site.name === "api.example.com" || site.name === "auth.example.net") return API_PATHS;
  if (site.name.startsWith("media.")) return MEDIA_PATHS;
  if (site.name.startsWith("download.")) return DOWNLOAD_PATHS;
  if (site.name.startsWith("static.") || site.name.startsWith("cdn.")) return ASSET_PATHS;
  return WEB_PATHS;
}

const CLIENTS = [
  "192.0.2.201",
  "203.0.113.5",
  "198.51.100.14",
  "192.0.2.57",
  "2001:db8:1f::b2",
  "203.0.113.34",
  "198.51.100.48",
  "192.0.2.88",
  "2001:db8:2a::14",
  "203.0.113.61",
  "198.51.100.71",
  "192.0.2.104",
  "203.0.113.89",
  "2001:db8:3c::9e",
  "198.51.100.95",
  "192.0.2.131",
  "203.0.113.112",
  "198.51.100.118",
  "2001:db8:58::31",
  "192.0.2.166",
  "203.0.113.158",
  "198.51.100.152",
  "192.0.2.190",
  "2001:db8:6d::c4",
  "203.0.113.183",
  "198.51.100.177",
  "192.0.2.233",
  "2001:db8:7e::5a",
  "203.0.113.207",
  "198.51.100.219",
  "2001:db8:a3::17",
  "203.0.113.236",
  "198.51.100.243",
  "2001:db8:e1::88",
  "192.0.2.23",
  "198.51.100.27",
];
const BROWSER_JA4 = [
  "t13d1516h2_8daaf6152771_02713d6af862",
  "t13d1516h2_8daaf6152771_e5627efa2ab1",
  "t13d1517h2_8daaf6152771_b0da82dd1658",
  "t13d1715h2_5b57614c22b0_3d5424432f57",
  "t13d1516h2_8daaf6152771_b186095e22b6",
];
const ATTACK_JA4 = "t13d190900_9dc949149365_97f8aa674fd9";
const WAVE_JA4 = "t13d311100_e8f1e7e78f70_d339722ba4af";

/** Sampled rate of each site's access logs in basis points (the UI offers 0, 1, 10, 100 %). */
function sampleRateOf(site: Site): number {
  if (!site.enabled) return 0;
  if (isShop(site)) return 1000;
  if (site.name === "api.example.com" || site.name === "auth.example.net") return 10_000;
  if (site.name === "blog.example.org") return 0;
  return 100;
}

/** One slot per 5 seconds; whether it holds a sampled request is decided by noise. */
const SLOT = 5_000;
const LOG_DAYS = 7;

const hex = (seed: number, chars: number) =>
  Array.from({ length: Math.ceil(chars / 8) }, (_, i) =>
    Math.floor(noise(seed * 7 + i * 104_729) * 0x1_0000_0000)
      .toString(16)
      .padStart(8, "0"),
  )
    .join("")
    .slice(0, chars);

const weighted = (list: PathSeed[]) => {
  const total = list.reduce((sum, p) => sum + p.weight, 0);
  return (r: number) => {
    let at = r * total;
    for (const p of list) {
      at -= p.weight;
      if (at <= 0) return p;
    }
    return list[list.length - 1] as PathSeed;
  };
};

interface LogContext {
  site: Site;
  seed: number;
  rate: number;
  pick: (r: number) => PathSeed;
  ja4: boolean;
  wafMode: SiteWaf["mode"];
  density: number;
  /** Nodes that served the site, with the time they stopped (offline nodes). */
  servers: { id: string; until: number }[];
}

function logContext(site: Site): LogContext {
  const protection = protectionOf(site);
  const shares: Record<string, number> = { "shop.example.com": 0.32, "api.example.com": 0.2 };
  return {
    site,
    seed: indexOf(site) * 1_000_003,
    rate: sampleRateOf(site),
    pick: weighted(profileOf(site)),
    ja4: protection.logJa4,
    wafMode: wafOf(site).mode,
    density: shares[site.name] ?? 0.08,
    servers: clusterNodes(site).map((n) => ({
      id: n.id,
      until: n.online ? Number.POSITIVE_INFINITY : Date.parse(n.lastSeenAt ?? ago(0)),
    })),
  };
}

function serverAt(ctx: LogContext, time: number, r: number): string {
  const live = ctx.servers.filter((s) => time < s.until);
  const list = live.length ? live : ctx.servers;
  return (list[Math.floor(r * list.length)] ?? list[0])?.id ?? id(4, 1);
}

function normalEntry(ctx: LogContext, k: number, time: number): LogEntry {
  const r = (salt: number) => noise(k * 17 + salt + ctx.seed);
  const p = ctx.pick(r(1));
  const client = CLIENTS[Math.floor(r(2) ** 1.6 * CLIENTS.length)] as string;
  const outcome = r(3);
  let method = "GET";
  let status = 200;
  let cacheStatus = "";
  let bytes = p.bytes;
  let duration = 0;
  const wafRuleIds: number[] = [];
  switch (p.kind) {
    case "asset":
      if (outcome < 0.05) {
        status = 304;
        cacheStatus = "HIT";
        bytes = 0;
      } else {
        cacheStatus =
          outcome < 0.86
            ? "HIT"
            : outcome < 0.94
              ? "MISS"
              : outcome < 0.97
                ? "EXPIRED"
                : "REVALIDATED";
      }
      duration = cacheStatus === "HIT" ? 1 + Math.floor(r(4) * 9) : 30 + Math.floor(r(4) * 180);
      break;
    case "page":
      cacheStatus =
        outcome < 0.58 ? "HIT" : outcome < 0.9 ? "MISS" : outcome < 0.96 ? "STALE" : "UPDATING";
      duration = cacheStatus === "MISS" ? 60 + Math.floor(r(4) * 340) : 2 + Math.floor(r(4) * 14);
      break;
    case "api":
      cacheStatus = outcome < 0.55 ? "HIT" : "MISS";
      duration = cacheStatus === "HIT" ? 2 + Math.floor(r(4) * 8) : 35 + Math.floor(r(4) * 210);
      if (outcome > 0.985) {
        status = 400;
        bytes = 180;
      }
      break;
    case "cart":
      method = outcome < 0.45 ? "GET" : outcome < 0.85 ? "POST" : outcome < 0.95 ? "PUT" : "DELETE";
      cacheStatus = "BYPASS";
      duration = 40 + Math.floor(r(4) * 260);
      if (outcome > 0.97) {
        status = 401;
        bytes = 96;
      }
      break;
    case "login":
      method = outcome < 0.5 ? "GET" : "POST";
      cacheStatus = method === "GET" ? "MISS" : "BYPASS";
      status = method === "POST" ? (outcome < 0.86 ? 302 : 401) : 200;
      bytes = method === "POST" ? 240 : p.bytes;
      duration = 70 + Math.floor(r(4) * 220);
      break;
    case "redirect":
      status = p.status ?? 301;
      duration = Math.floor(r(4) * 2);
      break;
    case "missing":
      status = 404;
      cacheStatus = outcome < 0.4 ? "HIT" : "MISS";
      duration = cacheStatus === "HIT" ? 2 : 40 + Math.floor(r(4) * 90);
      break;
    case "media":
      status = outcome < 0.7 ? 206 : 200;
      cacheStatus = outcome < 0.9 ? "HIT" : "MISS";
      bytes = status === 206 ? Math.round(p.bytes / (4 + Math.floor(r(5) * 12))) : p.bytes;
      duration = 40 + Math.floor(r(4) * (cacheStatus === "HIT" ? 900 : 3_200));
      break;
  }
  // Now and then the origin fails: refused or timed out connections.
  const failure = r(6);
  if (cacheStatus === "MISS" && failure < 0.012) {
    status = failure < 0.007 ? 502 : 504;
    bytes = 1_980;
    duration = status === 504 ? 10_000 + Math.floor(r(7) * 40) : 3 + Math.floor(r(7) * 20);
  }
  // CRS matches of ordinary traffic: a notice now and then (no user agent), and a critical match
  // that reaches the anomaly threshold, which block mode answers with 403.
  const waf = r(8);
  let wafBlocked = false;
  if (ctx.wafMode !== "off" && waf < 0.02 && p.kind !== "redirect") {
    if (waf < 0.013) wafRuleIds.push(920320);
    else {
      wafRuleIds.push(942200, 942260);
      if (ctx.wafMode === "block") {
        wafBlocked = true;
        status = 403;
        cacheStatus = "";
        bytes = 1_412;
        duration = 1 + Math.floor(r(10) * 3);
      }
    }
  }
  return entry(ctx, k, 0, time, r, {
    clientIp: client,
    method,
    host: p.host ?? (ctx.site.domains[0] as string),
    path: p.path,
    status,
    bytesSent: bytes,
    durationMs: duration,
    cacheStatus,
    ja4: ctx.ja4 ? (BROWSER_JA4[Math.floor(r(9) * BROWSER_JA4.length)] as string) : "",
    wafRuleIds,
    wafBlocked,
  });
}

/** A refused request of the burst or of the wave. */
function attackEntry(ctx: LogContext, k: number, time: number, wave: boolean): LogEntry {
  const r = (salt: number) => noise(k * 23 + salt + ctx.seed + 77);
  const ips = wave ? WAVE_IPS : ATTACKERS;
  const client = ips[Math.floor(r(1) ** 1.4 * ips.length)] as string;
  const path = wave
    ? "/search"
    : r(2) < 0.62
      ? "/api/v2/cart"
      : r(2) < 0.92
        ? "/account/login"
        : "/api/v2/cart/items";
  const crs = !wave && r(3) < 0.22;
  const status = crs ? 403 : wave ? (r(4) < 0.7 ? 429 : 403) : r(4) < 0.6 ? 429 : 403;
  return entry(ctx, k, 1, time, r, {
    clientIp: client,
    method: wave ? "GET" : "POST",
    host: SHOP.domains[0] as string,
    path,
    status,
    bytesSent: crs ? 1_412 : status === 429 ? 1_168 : 1_296,
    durationMs: Math.floor(r(5) * 3),
    cacheStatus: "",
    ja4: ctx.ja4 ? (wave ? WAVE_JA4 : ATTACK_JA4) : "",
    wafRuleIds: crs ? (r(6) < 0.5 ? [942100, 942200] : [941100]) : [],
    wafBlocked: crs,
  });
}

function entry(
  ctx: LogContext,
  k: number,
  index: number,
  time: number,
  r: (salt: number) => number,
  fields: Omit<LogEntry, "id" | "time" | "nodeId" | "siteId" | "sampleRate" | "requestId">,
): LogEntry {
  const nodeId = serverAt(ctx, time, r(11));
  return {
    id: `${nodeId}/${k}/${index}`,
    time: new Date(time).toISOString(),
    nodeId,
    siteId: ctx.site.id,
    sampleRate: ctx.rate,
    requestId: hex(k * 2 + index + ctx.seed, 32),
    ...fields,
  };
}

const bell = (time: number, at: number, sigma: number) =>
  Math.exp(-((time - at) ** 2) / (2 * sigma ** 2));

/** The sampled requests of one slot (the newest first). */
function slotEntries(ctx: LogContext, k: number): LogEntry[] {
  const start = k * SLOT;
  const out: LogEntry[] = [];
  if (isShop(ctx.site)) {
    const attack =
      0.95 * bell(start, SPIKE_AT, SPIKE_SIGMA) + 0.55 * bell(start, WAVE_AT, WAVE_SIGMA);
    if (noise(k * 5 + 3 + ctx.seed) < attack) {
      const wave = Math.abs(start - WAVE_AT) < Math.abs(start - SPIKE_AT);
      out.push(attackEntry(ctx, k, start + noise(k * 5 + 4 + ctx.seed) * SLOT, wave));
    }
  }
  if (noise(k * 5 + 1 + ctx.seed) < ctx.density)
    out.push(normalEntry(ctx, k, start + noise(k * 5 + 2 + ctx.seed) * SLOT));
  return out.sort((a, b) => b.time.localeCompare(a.time));
}

function queryLogs(input: {
  siteId: string;
  from: string;
  to: string;
  status?: unknown;
  ip?: string;
  path?: string;
  requestId?: string;
  limit?: unknown;
}): { entries: LogEntry[]; truncated: boolean } {
  const site = siteOf(input.siteId);
  const ctx = logContext(site);
  const limit = Number(input.limit ?? 100);
  const from = Math.max(Date.parse(input.from), Date.now() - LOG_DAYS * DAY);
  const to = Math.min(Date.parse(input.to), Date.now());
  if (ctx.rate === 0 || !(from < to)) return { entries: [], truncated: false };
  const status =
    input.status === undefined || input.status === "" ? undefined : Number(input.status);
  const ip = input.ip?.trim() ?? "";
  const path = input.path ?? "";
  const requestId = input.requestId?.trim() ?? "";
  const out: LogEntry[] = [];
  for (let k = Math.floor(to / SLOT); k >= Math.floor(from / SLOT); k--) {
    for (const e of slotEntries(ctx, k)) {
      const time = Date.parse(e.time);
      if (time < from || time >= to) continue;
      if (status !== undefined && e.status !== status) continue;
      if (ip && e.clientIp !== ip) continue;
      if (path && !e.path.startsWith(path)) continue;
      if (requestId && e.requestId !== requestId) continue;
      out.push(e);
      if (out.length > limit) return { entries: out.slice(0, limit), truncated: true };
    }
  }
  return { entries: out, truncated: false };
}

// ---------------------------------------------------------------------------------------------
// HTTPS and DNS

const covers = (names: string[], domain: string) =>
  names.some(
    (name) =>
      name === domain ||
      (name.startsWith("*.") &&
        domain.endsWith(name.slice(1)) &&
        domain.split(".").length === name.split(".").length),
  );

const issued = (cert: CertificateDto) =>
  cert.status === "ready" &&
  !!cert.fingerprint &&
  !!cert.notAfter &&
  Date.parse(cert.notAfter) > Date.now();

/** Issued certificates of the access fixtures that cover every domain of the site. */
const coveringCertificates = (site: Site) =>
  certificates.filter(
    (cert) => issued(cert) && site.domains.every((domain) => covers(cert.names, domain)),
  );

const DEFAULT_TYPES = [...DEFAULT_COMPRESSION_TYPES];

function httpsOf(site: Site): TlsSettings {
  const certificateId = siteCertificateId(site.id);
  const base: TlsSettings = {
    certificateId,
    additionalCertificateIds: [],
    forceHttps: false,
    hstsMaxAge: 0,
    hstsIncludeSubdomains: false,
    hstsPreload: false,
    minimumVersion: "1.2",
    cipherProfile: "modern",
    http2: true,
    http3: false,
    brotli: false,
    brotliLevel: 6,
    brotliMinLength: 256,
    brotliTypes: DEFAULT_TYPES,
    zstd: false,
    zstdLevel: 3,
    zstdMinLength: 256,
    zstdTypes: DEFAULT_TYPES,
    gzip: true,
    gzipMinLength: 256,
    gzipTypes: DEFAULT_TYPES,
    gzipLevel: 0,
    compressMaxLength: 0,
    ocspStapling: false,
    redirectStatus: 301,
    redirectPort: 443,
    redirectExcludedDomains: [],
    clientCertificate: { mode: "off", caPem: "", depth: 2, forwardHeaders: false },
  };
  if (!certificateId) return base;
  if (isShop(site))
    return {
      ...base,
      forceHttps: true,
      hstsMaxAge: 31_536_000,
      hstsIncludeSubdomains: true,
      http3: true,
      brotli: true,
      brotliLevel: 5,
      brotliMinLength: 512,
      brotliTypes: [...DEFAULT_TYPES, "application/xml", "font/ttf"],
      zstd: true,
      zstdLevel: 3,
      zstdMinLength: 512,
      gzipMinLength: 512,
      gzipLevel: 5,
      // Product videos and catalogs in PDF go out as they are.
      compressMaxLength: 8 * 1024 * 1024,
      ocspStapling: true,
      // 308 keeps the method of checkout posts that still use http://.
      redirectStatus: 308,
    };
  const strict = site.name === "auth.example.net" || site.name === "api.example.com";
  return {
    ...base,
    forceHttps: true,
    hstsMaxAge: strict ? 63_072_000 : 15_552_000,
    hstsPreload: strict,
    hstsIncludeSubdomains: strict,
    minimumVersion: strict ? "1.3" : "1.2",
    http3: indexOf(site) % 2 === 1,
    brotli: true,
  };
}

function httpsCheck(site: Site): HttpsCheck {
  const list = coveringCertificates(site);
  const blockers: HttpsCheck["blockers"] = [];
  const online = clusterNodes(site).filter((n) => n.online);
  if (!online.length) blockers.push({ code: "nodes_offline", cluster: site.clusterName });
  if (site.name === "media.example.net")
    blockers.push({ code: "dns_not_pointing", name: "video.example.net", pointing: "elsewhere" });
  if (site.name === "legacy.example.org")
    blockers.push({ code: "dns_not_pointing", name: "legacy.example.org", pointing: "unresolved" });
  return {
    request: {
      name: site.name,
      names: site.domains,
      email: "ops@example.com",
      challenge: site.domains.some((d) => d.startsWith("*.")) ? "dns01" : "http01",
      dnsCredentialId: null,
    },
    blockers,
    certificates: list.map((c) => ({ id: c.id, name: c.name })),
  };
}

/** A cluster's DNS binding: the infra fixtures' (dns.binding), else these. */
const BINDINGS: Record<
  string,
  { mode: "off" | "manual" | "auto"; domain: string; lines: string[] }
> = {
  "apac-edge": { mode: "auto", domain: "apac.cdn.example.net", lines: ["tokyo", "singapore"] },
  "eu-edge": { mode: "manual", domain: "eu.cdn.example.net", lines: [] },
  "na-edge": { mode: "auto", domain: "na.cdn.example.net", lines: [] },
};

async function bindingOf(clusterId: string) {
  try {
    const state = await infraFixtures.dns?.binding?.({ clusterId });
    if (state)
      return {
        mode: state.binding.mode,
        domain: state.binding.domain,
        lines: state.binding.lines.map((l) => l.name),
        lineAliases: state.binding.lineAliases,
      };
  } catch {
    // The infra fixtures do not know the cluster: fall back to these.
  }
  const name = clusters.find((c) => c.id === clusterId)?.name ?? "";
  const fallback = BINDINGS[name] ?? { mode: "off" as const, domain: "", lines: [] };
  return { ...fallback, lineAliases: false };
}

async function siteTarget(site: Site) {
  const binding = await bindingOf(site.clusterId);
  if (binding.mode === "off" || !binding.domain)
    return {
      target: null,
      mode: "off" as const,
      published: false,
      healthy: false,
      lines: [],
      retired: [],
    };
  const target = `${site.cnamePrefix}.${binding.domain}`;
  const lines = binding.lines.map((name) => ({
    name,
    target: binding.lineAliases ? `${name}.${target}` : `${name}.${binding.domain}`,
  }));
  if (binding.mode === "manual")
    return {
      target,
      mode: "manual" as const,
      published: false,
      healthy: false,
      lines,
      retired: [],
    };
  return {
    target,
    mode: "auto" as const,
    published: site.enabled,
    healthy: clusterNodes(site).some((n) => n.online && n.dataPlaneHealthy),
    lines,
    retired: [],
  };
}

// ---------------------------------------------------------------------------------------------

const rangeOf = (range: AnalyticsRange | undefined) => range ?? "24h";

export const siteDetailFixtures: Fixtures = {
  rules: {
    get: ({ id: siteId }) => siteRules(siteOf(siteId)),
    topLogged: (input) =>
      topLogged(siteOf(input.id), rangeOf(input.range), Number(input.limit ?? 10)),
  },
  platformRules: {
    get: () => platformRuleList,
  },
  bulkRedirects: {
    get: ({ id: siteId }) => redirectsOf(siteOf(siteId)),
  },
  waf: {
    get: ({ id: siteId }) => wafOf(siteOf(siteId)),
    topRules: (input) =>
      wafTopRules(siteOf(input.id), rangeOf(input.range), Number(input.limit ?? 10)),
  },
  protection: {
    get: ({ id: siteId }) => protectionOf(siteOf(siteId)),
  },
  security: {
    state: (input) => securityState(siteOf(input.id), Number(input.hours ?? 24)),
    events: (input) => {
      const all = cachedEvents(siteOf(input.id)).filter(
        (e) => !input.kind || e.kind === input.kind,
      );
      const page = Number(input.page ?? 1);
      const size = Number(input.pageSize ?? 50);
      return { items: all.slice((page - 1) * size, page * size), total: all.length };
    },
  },
  errorPages: {
    get: ({ id: siteId }) => errorPagesOf(siteOf(siteId)),
  },
  maintenance: {
    get: ({ id: siteId }) => maintenanceOf(siteOf(siteId)),
  },
  authRules: {
    get: ({ id: siteId }) => authRulesOf(siteOf(siteId)),
    failures: (input) => ({
      requests: isShop(siteOf(input.id)) ? 1284 : 0,
      unsupportedNodes: 0,
    }),
  },
  logs: {
    settings: ({ siteId }) => ({ sampleRate: sampleRateOf(siteOf(siteId)), storage: "lite" }),
    query: (input) => queryLogs(input),
    export: (input) => {
      const { entries, truncated } = queryLogs({ ...input, limit: input.limit ?? 1000 });
      const columns = [
        "time",
        "clientIp",
        "method",
        "host",
        "path",
        "status",
        "bytesSent",
        "durationMs",
        "cacheStatus",
        "requestId",
      ] as const;
      const rows = entries.map((e) => columns.map((c) => String(e[c])).join(","));
      return { csv: [columns.join(","), ...rows].join("\n"), truncated };
    },
  },
  https: {
    get: ({ id: siteId }) => httpsOf(siteOf(siteId)),
    check: ({ id: siteId }) => httpsCheck(siteOf(siteId)),
  },
  dns: {
    siteTarget: ({ siteId }) => siteTarget(siteOf(siteId)),
  },
};
