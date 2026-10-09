import { parseExpression } from "@edgeweir/rule-engine";
import type { CompileInput, RuleModel, SiteProtectionModel, SiteWafModel } from "../src/index";
import { site, tls } from "./v0230-models";

const rule = (
  id: string,
  phase: string,
  source: string,
  action: RuleModel["action"],
): RuleModel => ({
  id,
  phase,
  expression: parseExpression(source, phase as never),
  action,
});

/**
 * Site a's rules behind the v0.29.0 vector: every waf-v2 action, a log rule
 * writing access log lines, a rate limit ban, the CRS override, and rules
 * reading the body (form_value, json_value) and the crawler fields.
 */
export const v0290Rules = (): RuleModel[] => [
  rule("r-ban", "waf-custom", 'form_value("user") eq "admin"', {
    kind: "ban",
    banSeconds: 3600,
    banScope: "site",
    banPrefixV4: 24,
    banPrefixV6: 64,
  }),
  rule("r-respond", "waf-custom", 'json_value("cmd.0") contains "rm"', {
    kind: "respond",
    statusCode: 200,
    contentType: "application/json",
    body: '{"ok":false}',
    errorPage: false,
  }),
  rule("r-page", "waf-custom", 'http.request.uri.path eq "/teapot"', {
    kind: "respond",
    statusCode: 418,
    contentType: "text/plain",
    body: "",
    errorPage: true,
  }),
  rule("r-close", "waf-custom", "http.request.body.truncated eq true", { kind: "close" }),
  rule(
    "r-skip",
    "waf-custom",
    'http.request.bot.verified eq true and http.request.bot.name eq "googlebot"',
    {
      kind: "skip",
      skip: ["rules", "crs", "challenges"],
    },
  ),
  rule("r-log", "waf-custom", 'http.request.body.filenames contains ".php"', {
    kind: "log",
    accessLog: true,
  }),
  rule("r-rate", "ratelimit", 'starts_with(http.request.uri.path, "/login")', {
    kind: "rate_limit",
    statusCode: 429,
    limit: 10,
    windowSeconds: 60,
    key: "ip.src",
    banSeconds: 600,
  }),
  rule("r-crs", "config", 'starts_with(http.request.uri.path, "/upload/")', {
    kind: "config",
    crs: "detect",
  }),
];

/** Site a's CRS: whole-site, path and target exclusions, given out of order inside each. */
export const v0290Waf = (): SiteWafModel => ({
  mode: "block",
  paranoiaLevel: 1,
  anomalyThreshold: 5,
  requestBodyLimit: 131072,
  exclusions: [
    { path: "", exact: false, ruleIds: [942100, 920350], targets: [] },
    { path: "/api/", exact: false, ruleIds: [942100, 941100], targets: [] },
    { path: "/login", exact: true, ruleIds: [942100], targets: ["ARGS:password", "ARGS:next"] },
    { path: "", exact: false, ruleIds: [932100], targets: ["REQUEST_COOKIES:session"] },
  ],
});

/** Site a's protection: Under Attack with verified crawlers, texts and failure bans. */
export const v0290Protection = (): SiteProtectionModel => ({
  underAttack: true,
  underAttackChallenge: "js",
  passTtlSeconds: 1800,
  powDifficulty: 16,
  powHighDifficulty: 20,
  cc: null,
  logJa4: false,
  allowVerifiedBots: true,
  challengeText: {
    titleZh: "访问验证",
    hintZh: "请稍候，验证完成后自动继续。",
    titleEn: "Checking your browser",
    hintEn: "",
  },
  failureBan: { threshold: 5, banSeconds: 900 },
});

/**
 * The console models behind the v0.29.0 vector: site a with every G14
 * feature and a rules body limit of 128 KiB; site b with none of its own,
 * but a platform rule reading json_value gives it the default body limit;
 * a platform rule bans at platform scope.
 */
export const v0290Models = (): CompileInput => ({
  clusterId: "c1",
  sites: [
    site("a", {
      tls: tls(),
      rules: v0290Rules(),
      rulesBodyLimit: 131072,
      waf: v0290Waf(),
      protection: v0290Protection(),
    }),
    site("b", { tls: tls() }),
  ],
  platformRules: [
    rule("p-ban", "waf-custom", 'json_value("probe") eq "1"', {
      kind: "ban",
      banSeconds: 86400,
      banScope: "platform",
      banPrefixV4: 32,
      banPrefixV6: 48,
    }),
  ],
  challengeKeys: [
    { id: "k1", role: "current" },
    { id: "k2", role: "next" },
  ],
});
