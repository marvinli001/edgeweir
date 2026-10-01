// node --experimental-transform-types scripts/vectors.mjs writes test/vectors.json; copy it to
// edgeweir-node test/lua/expression-vectors.json, then `pnpm exec biome format --write` this copy.
import { writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  bindLists,
  cacheConditionExpression,
  evaluate,
  evaluateValue,
  mediaType,
  parseExpression,
  parseValueExpression,
  pathExtension,
  structuredCacheCondition,
  structuredCacheMatch,
  validActionIr,
  validExpressionIr,
} from "../src/index.ts";

const cases = [
  ["true or false and false", {}, true],
  [
    'http.host eq "example.test" and not http.request.method in {"POST" "PUT"}',
    { "http.host": "example.test", "http.request.method": "GET" },
    true,
  ],
  [
    'http.host eq "example.test" or http.request.method eq "PUT"',
    { "http.host": "other.test", "http.request.method": "GET" },
    false,
  ],
  [
    'http.request.uri.path matches "^/(api|assets)/"',
    { "http.request.uri.path": "/assets/app.js" },
    true,
  ],
  ['http.request.uri.path matches "^/a.$"', { "http.request.uri.path": "/a中" }, false],
  ['http.request.uri.path contains "中"', { "http.request.uri.path": "/中" }, true],
  ['http.request.headers["X-Region"] eq "nz"', { "http.request.headers.x-region": "nz" }, true],
  [
    'ssl eq true and http.host contains "example"',
    { ssl: true, "http.host": "example.test" },
    true,
  ],
  ["ip.src in {192.0.2.0/24 2001:db8::/32}", { "ip.src": "192.0.2.12" }, true],
  ["ip.src in {192.0.2.0/24}", { "ip.src": "::ffff:192.0.2.12" }, true],
  ["ip.src in {192.0.2.0/24}", { "ip.src": "64:ff9b::c000:020c" }, false],
  ["ip.src in {2001:db8::/32}", { "ip.src": "2001:db8:ffff::1" }, true],
  ["ip.src ne 192.0.2.1", { "ip.src": "192.0.2.2" }, true],
  ["ip.src in $blocked", { "ip.src": "192.0.2.5" }, true],
  ["ip.src in $blocked", { "ip.src": "198.51.100.5" }, false],
  ["ip.geoip.asnum in {13335 15169}", { "ip.geoip.asnum": 13335 }, true],
  [
    'ip.geoip.country eq "NZ" and ip.geoip.subdivision eq "AUK"',
    { "ip.geoip.country": "NZ", "ip.geoip.subdivision": "AUK" },
    true,
  ],
  ["http.response.code ge 500", { "http.response.code": 503 }, true, "response-transform"],
  [
    'http.response.headers["X-Test"] ne ""',
    { "http.response.headers.x-test": "yes" },
    true,
    "response-transform",
  ],
  ...regexCases(),
  ...ja4Cases(),
  ...functionCases(),
  ...v2ActionCases(),
];

// rules-v2 functions in conditions (byte strings, ASCII case mapping).
function functionCases() {
  const path = (p) => ({ "http.request.uri.path": p });
  const query = (q) => ({ "http.request.uri.query": q });
  return [
    ['lower(http.host) eq "example.test"', { "http.host": "EXAMPLE.Test" }, true],
    ['upper(http.request.method) in {"GET" "HEAD"}', { "http.request.method": "get" }, true],
    ['lower(http.request.uri.path) eq "/é"', path("/É"), false],
    ['upper(http.request.uri.path) eq "/é"', path("/é"), true],
    ['upper(http.request.uri.path) eq "/A中"', path("/a中"), true],
    ["len(http.request.uri.query) gt 10", query("a=12345678901"), true],
    ["len(http.request.uri.path) eq 4", path("/中"), true],
    ["len(http.request.uri.query) eq 0", {}, true],
    ['starts_with(http.request.uri.path, "/api/")', path("/api/v1"), true],
    ['starts_with(http.request.uri.path, "/API/")', path("/api/v1"), false],
    ['starts_with(http.request.uri.path, "")', path("/x"), true],
    ['starts_with(http.request.uri.path, "/中")', path("/中文"), true],
    ['not ends_with(http.request.uri.path, ".php")', path("/index.php"), false],
    ['ends_with(lower(http.request.uri.path), ".php")', path("/INDEX.PHP"), true],
    [
      'ends_with(http.host, http.request.headers["x-suffix"])',
      { "http.host": "a.example.test", "http.request.headers.x-suffix": "example.test" },
      true,
    ],
    ['starts_with(http.request.uri.path, "/a") eq false', path("/b"), true],
    ['url_decode(http.request.uri.query) contains "<script"', query("q=%3Cscript%3E"), true],
    ['url_decode(http.request.uri.query) eq "a b+c"', query("a+b%2Bc"), true],
    ['url_decode(http.request.uri.query) eq "%zz%4"', query("%zz%4"), true],
    ['url_decode(http.request.uri.query) eq "%41"', query("%2541"), true],
    ['url_decode(http.request.uri.query) eq "a\\u0000b"', query("a%00b"), true],
    ['url_decode(http.request.uri.path) eq "/中"', path("/%E4%B8%ad"), true],
    ["len(url_decode(http.request.uri.query)) ge 3", query("%41%42%43"), true],
    [
      'concat(http.request.method, " ", http.request.uri.path) eq "GET /x"',
      { "http.request.method": "GET", "http.request.uri.path": "/x" },
      true,
    ],
    [
      'concat(lower(http.host), http.request.uri.path) matches "^example\\\\.test/a"',
      { "http.host": "Example.TEST", "http.request.uri.path": "/a" },
      true,
    ],
    [
      'starts_with(concat("/", lower(http.request.headers["x-region"])), "/nz")',
      { "http.request.headers.x-region": "NZ-1" },
      true,
    ],
    [
      'lower(http.request.headers["x-a"]) in {"one" "two"}',
      { "http.request.headers.x-a": "TWO" },
      true,
    ],
    ["len(lower(upper(lower(http.host)))) eq 12", { "http.host": "example.test" }, true],
    [
      'http.request.uri.path.extension in {"png" "jpg"}',
      { "http.request.uri.path.extension": "png" },
      true,
    ],
    [
      'http.request.full_uri eq "https://example.test/a?b=1"',
      { "http.request.full_uri": "https://example.test/a?b=1" },
      true,
    ],
    [
      'http.response.content_type.media_type eq "text/html"',
      { "http.response.content_type.media_type": "text/html" },
      true,
      "compression",
      { kind: "compression", compression: ["br", "gzip"] },
    ],
    [
      'http.response.headers["content-type"] contains "json" and http.response.code eq 200',
      { "http.response.headers.content-type": "application/json", "http.response.code": 200 },
      true,
      "compression",
      { kind: "compression", compression: [] },
    ],
    [
      'http.response.content_type.media_type in {"image/png" "image/jpeg"}',
      { "http.response.content_type.media_type": "image/png" },
      true,
      "response-transform",
    ],
  ];
}

// rules-v2 actions with conditions.
function v2ActionCases() {
  const api = { "http.request.uri.path": "/api/v1" };
  return [
    [
      'starts_with(http.request.uri.path, "/api/")',
      api,
      true,
      "origin",
      {
        kind: "origin",
        originGroup: "api",
        hostHeader: "api.example.test",
        sni: "api.example.test",
        port: 8443,
      },
    ],
    [
      'http.request.uri.path eq "/x"',
      { "http.request.uri.path": "/x" },
      true,
      "origin",
      { kind: "origin", port: 8080 },
    ],
    [
      'starts_with(http.request.uri.path, "/live/")',
      { "http.request.uri.path": "/live/a" },
      true,
      "config",
      {
        kind: "config",
        gzip: true,
        brotli: false,
        zstd: false,
        websocket: false,
        underAttack: true,
        ccEnabled: false,
        ccMaxLevel: "js",
        originConnectTimeoutMs: 2000,
        originSendTimeoutMs: 30000,
        originReadTimeoutMs: 5000,
        logSampleRate: 10000,
      },
    ],
    [
      'http.request.uri.path eq "/x"',
      { "http.request.uri.path": "/x" },
      true,
      "config",
      { kind: "config", logSampleRate: 0 },
    ],
    [
      'http.request.uri.path eq "/old"',
      { "http.request.uri.path": "/old" },
      true,
      "redirect",
      {
        kind: "redirect",
        value: "https://example.test/new?a=1#top",
        statusCode: 308,
        preserveQuery: true,
        setQuery: [
          { name: "lang", value: "zh CN" },
          { name: "src", value: "old" },
        ],
        removeQuery: ["session", "utm_source"],
      },
    ],
    [
      'starts_with(http.request.uri.path, "/old/")',
      { "http.request.uri.path": "/old/a" },
      true,
      "redirect",
      {
        kind: "redirect",
        target: parseValueExpression(
          'regex_replace(http.request.uri.path, "^/old/(.*)$", "/new/${1}")',
          "redirect",
        ),
        statusCode: 301,
      },
    ],
    [
      'starts_with(http.request.uri.path, "/v1/")',
      { "http.request.uri.path": "/v1/a" },
      true,
      "request-transform",
      {
        kind: "rewrite",
        target: parseValueExpression(
          'wildcard_replace(http.request.uri.path, "/v1/*", "/v2/${1}")',
          "request-transform",
        ),
        preserveQuery: false,
        setQuery: [{ name: "v", value: "2" }],
      },
    ],
    [
      'http.request.uri.path eq "/a"',
      { "http.request.uri.path": "/a" },
      true,
      "request-transform",
      { kind: "rewrite", value: "/b", removeQuery: ["debug"] },
    ],
  ];
}

// rules-v2 value expressions (redirect targets and rewrite paths): the node computes
// `expected` (UTF-8) from `request`.
function valueCases() {
  const path = (p) => ({ "http.request.uri.path": p });
  return [
    ['concat("https://example.test", http.request.uri.path)', path("/a"), "https://example.test/a"],
    [
      'regex_replace(http.request.uri.path, "^/old/(.*)$", "/new/${1}")',
      path("/old/a/b"),
      "/new/a/b",
    ],
    ['regex_replace(http.request.uri.path, "^/old/(.*)$", "/new/${1}")', path("/x"), "/x"],
    ['regex_replace(http.request.uri.path, "a", "b")', path("/aaa"), "/baa"],
    ['regex_replace(http.request.uri.path, "^/(x)|^/(y)$", "[${1}|${2}]")', path("/y"), "[|y]"],
    ['regex_replace(http.request.uri.path, "^/(p)$", "/$1/$${1}")', path("/p"), "/$1/$p"],
    ['regex_replace(http.request.uri.path, "^", "/v2")', path("/a"), "/v2/a"],
    ['regex_replace(http.request.uri.path, "^/.{3}", "/x")', path("/中a"), "/xa"],
    ['regex_replace(lower(http.request.uri.path), "\\\\.html$", "")', path("/A.HTML"), "/a"],
    [
      'wildcard_replace(http.request.full_uri, "https://*.example.test/*", "https://example.test/${1}/${2}")',
      { "http.request.full_uri": "https://shop.example.test/a/b?c=1" },
      "https://example.test/shop/a/b?c=1",
    ],
    [
      'wildcard_replace(http.request.uri.path, "/IMG/*", "/images/${1}")',
      path("/img/A.png"),
      "/images/A.png",
    ],
    [
      'wildcard_replace(http.request.uri.path, "/IMG/*", "/images/${1}", "s")',
      path("/img/A.png"),
      "/img/A.png",
    ],
    ['wildcard_replace(http.request.uri.path, "/*/*", "${1}|${2}")', path("/a/b/c"), "a|b/c"],
    ['wildcard_replace(http.request.uri.path, "/**", "[${1}][${2}]")', path("/abc"), "[][abc]"],
    ['wildcard_replace(http.request.uri.path, "/a\\\\*b/*", "/${1}")', path("/a*b/x"), "/x"],
    ['wildcard_replace(http.request.uri.path, "/a\\\\\\\\b", "/c")', path("/a\\b"), "/c"],
    ['wildcard_replace(http.request.uri.path, "/exact", "/other")', path("/exact"), "/other"],
    ['wildcard_replace(http.request.uri.path, "/exact", "/other")', path("/exactly"), "/exactly"],
    ['wildcard_replace(http.request.uri.path, "/a*a", "${1}")', path("/a"), "/a"],
    ['wildcard_replace(http.request.uri.path, "/a*a", "<${1}>")', path("/aa"), "<>"],
    ['wildcard_replace(http.request.uri.path, "/É*", "${1}")', path("/éx"), "/éx"],
    [
      'wildcard_replace(http.request.uri.path, "/*.html", "/${1}")',
      path("/a.html.html"),
      "/a.html",
    ],
    [
      'concat("/search/", url_decode(http.request.uri.query))',
      { "http.request.uri.query": "q%20x+y" },
      "/search/q x y",
    ],
    ['"/static"', {}, "/static"],
    ["http.request.uri.path", path("/p"), "/p"],
    ["lower(http.host)", { "http.host": "A.Example.TEST" }, "a.example.test"],
    ['concat(http.request.uri.path, "?", http.request.uri.query)', path("/中"), "/中?"],
  ];
}

// tls.ja4 (a string, empty over plain HTTP) and the actions that go with it. The optional fifth
// element is the compiled action (config.proto RuleAction, JSON names) of the rule the vector
// belongs to: nodes accept it in the vector's phase (validActionIr).
function ja4Cases() {
  const ja4 = "t13d1516h2_8daaf6152771_02713d6af862";
  return [
    [
      `tls.ja4 eq "${ja4}"`,
      { "tls.ja4": ja4 },
      true,
      "waf-custom",
      { kind: "challenge", challenge: "js" },
    ],
    [
      'tls.ja4 matches "^t13d[0-9]{4}h2_"',
      { "tls.ja4": ja4 },
      true,
      "waf-custom",
      { kind: "challenge", challenge: "pow" },
    ],
    [
      'tls.ja4 matches "^t13d[0-9]{4}h2_"',
      { "tls.ja4": "q13d0310h3_55b375c5d22e_cd85d2d88918" },
      false,
      "waf-custom",
      { kind: "challenge", challenge: "captcha" },
    ],
    [
      'ssl eq false and tls.ja4 eq ""',
      { ssl: false },
      true,
      "waf-custom",
      { kind: "challenge", challenge: "cookie302" },
    ],
    [
      `tls.ja4 in {"${ja4}" "t13d1517h2_8daaf6152771_b0da82dd1658"}`,
      { "tls.ja4": "t12d1209h1_d34a8e72043a_b39be8c56a14" },
      false,
      "waf-custom",
      { kind: "block", statusCode: 403 },
    ],
    [
      'tls.ja4 contains "_8daaf6152771_"',
      { "tls.ja4": ja4 },
      true,
      "ratelimit",
      { kind: "rate_limit", statusCode: 429, limit: 100, windowSeconds: 60, key: "tls.ja4" },
    ],
    [
      'tls.ja4 ne ""',
      { "tls.ja4": ja4 },
      true,
      "request-transform",
      { kind: "request_header", header: "x-ja4-seen", value: "1" },
    ],
    [
      'http.request.uri.path eq "/login" and not tls.ja4 in {"t13d1516h2_8daaf6152771_02713d6af862"}',
      { "http.request.uri.path": "/login", "tls.ja4": "" },
      true,
      "waf-custom",
      { kind: "challenge", challenge: "js" },
    ],
  ];
}

// Valid expressions whose action nodes refuse in that phase; old consumers read them as
// accepted expression vectors.
const rejectedActions = [
  [
    'tls.ja4 eq ""',
    { "tls.ja4": "" },
    true,
    "ratelimit",
    { kind: "challenge", challenge: "js" },
    "challenge runs in waf-custom only",
  ],
  [
    'http.request.uri.path eq "/"',
    { "http.request.uri.path": "/" },
    true,
    "waf-custom",
    { kind: "challenge", challenge: "slider" },
    "unknown challenge type (there is no slider)",
  ],
  [
    'http.request.uri.path eq "/"',
    { "http.request.uri.path": "/" },
    true,
    "waf-custom",
    { kind: "challenge" },
    "challenge type required",
  ],
  [
    'tls.ja4 ne ""',
    { "tls.ja4": "x" },
    true,
    "ratelimit",
    { kind: "rate_limit", statusCode: 429, limit: 10, windowSeconds: 10, key: "tls.ja3" },
    "unknown rate limit key",
  ],
];

// `matches` on http.request.uri.path (or `field`); an undefined subject leaves the field unset.
function regex(pattern, subject, expected, field = "http.request.uri.path") {
  const request = subject === undefined ? {} : { [field]: subject };
  return [`${field} matches ${JSON.stringify(pattern)}`, request, expected];
}
// The portable subset (validatePattern) evaluated over UTF-8 bytes. Lua runs these with PCRE2,
// the node's Go test with RE2 (one rune per byte) and validates them with configir.
function regexCases() {
  return [
    // `$` is the end of the value; PCRE2's own `$` also matches before a final "\n".
    regex("^/admin$", "/admin", true),
    regex("^/admin$", "/admin\n", false),
    regex("^/admin\\n$", "/admin\n", true),
    regex("^/(admin$|api)", "/admin\n", false),
    regex("^/a\\$$", "/a$", true),
    regex("^/a[$]$", "/a$", true),
    regex("/admin$", "/x/admin", true),
    regex("^admin", "/admin", false),
    regex("^$", undefined, true),
    regex("^$", "/", false),
    regex("", "/x", true),
    // `.` is any byte but "\n" (JavaScript's own `.` also skips "\r"); classes match "\n".
    regex("^/a.$", "/a\r", true),
    regex("^/a.$", "/a\n", false),
    regex("^/a[^x]$", "/a\n", true),
    regex("^/a\\D\\W$", "/a\n\n", true),
    regex("^/a\\r\\n$", "/a\r\n", true),
    regex("^/a\\x0b\\t\\f$", "/a\u000b\t\f", true),
    regex("^a\\x00b$", "a\u0000b", true),
    // Case-sensitive; no flags.
    regex("^/Admin", "/admin", false),
    regex("^/[Aa]dmin", "/Admin", true),
    regex("^/\\x41", "/a", false),
    regex("^/[A-Z]+$", "/abc", false),
    // ASCII \w and \b; non-ASCII text is one character per UTF-8 byte.
    regex("\\bapi\\b", "/v1/api/x", true),
    regex("\\bapi\\b", "/v1/apix", false),
    regex("\\bapi", "/éapi", true),
    regex("a\\Bpi", "/api", true),
    regex("^/\\w+$", "/é", false),
    regex("^/\\W{2}$", "/é", true),
    regex("^/.{2}$", "/é", true),
    regex("^/a...$", "/a中", true),
    regex("^/[^/]{3}$", "/中", true),
    regex("[^\\x00-\\x7f]", "/中", true),
    regex("[^\\x00-\\x7f]", "/abc", false),
    // Classes.
    regex("^/[a-z0-9-]+$", "/abc-123", true),
    regex("^/[^/]+$", "/a/b", false),
    regex("^[.]$", "x", false),
    regex("^[\\w.-]+$", "file.name-1", true),
    regex("^[\\]\\\\]+$", "]\\", true),
    regex("^[a^]$", "^", true),
    regex("^[-a]+$", "-a-", true),
    regex("^[!-\\/]+$", "+-,", true),
    regex("^[\\t-\\r]$", "\u000b", true),
    regex("^[\\--/]+$", "-./", true),
    regex("^[-a-z\\d-]+$", "-a-1", true),
    regex("^[:]$", ":", true),
    regex("^[.]$", ".", true),
    regex("^\\x7F$", "\u007f", true),
    // Repetition and groups.
    regex("^a{2}$", "aa", true),
    regex("^a{2}$", "aaa", false),
    regex("^a{2,}$", "aaaa", true),
    regex("^a{0}$", "", true),
    regex("^a{1,2}?b", "aab", true),
    regex("^/a*?$", "/aaa", true),
    regex("^/(|x)y$", "/y", true),
    regex("^/(a|b)c$", "/bc", true),
    regex("^a{0,1000}?$", "aaa", true),
    regex("\\bx\\B", "/xy", true),
    regex("a$|^b", "bz", true),
    // Escaped punctuation.
    regex("^/a\\.b\\?c=\\{1\\}$", "/a.b?c={1}", true, "http.request.uri"),
    regex("^/a\\.b$", "/axb", false),
    [
      'http.request.headers["User-Agent"] matches "^curl/[0-9.]+$"',
      { "http.request.headers.user-agent": "curl/8.5.0" },
      true,
    ],
  ];
}

// Patterns outside the subset, most of them read differently by JavaScript, RE2 and PCRE2.
// The console and configir must both refuse them; they never reach Lua.
const rejected = [
  ["a{,2}", "PCRE2 reads {,n} as {0,n}; JavaScript and RE2 read it literally"],
  ["a{ 2 }", "PCRE2 allows spaces inside {n}; JavaScript and RE2 read it literally"],
  ["a{01}", "RE2 reads {01} literally; JavaScript and PCRE2 repeat"],
  ["a{2,1}", "reversed repetition bounds"],
  ["a{1001}", "RE2 repeats at most 1000 times"],
  ["a{0,1001}", "RE2 repeats at most 1000 times"],
  ["a{1000000000000000000000}", "RE2 repeats at most 1000 times"],
  ["a{x}", "an unescaped { must start a repetition"],
  ["a}", "unescaped }: literal only by engine leniency"],
  ["a]", "unescaped ] outside a class: literal only by engine leniency"],
  ["a**", "stacked quantifiers: errors in JavaScript and RE2"],
  ["a{1,}{2}", "stacked quantifiers: errors in JavaScript and RE2"],
  ["a???", "only one lazy ? may follow a quantifier"],
  ["a*+", "possessive in PCRE2; errors in JavaScript and RE2"],
  ["a{2}+", "possessive in PCRE2; errors in JavaScript and RE2"],
  ["(a)+", "repeated group (backtracking cost)"],
  ["(ab|a)*c", "repeated group (backtracking cost)"],
  ["(a){2}", "repeated group (backtracking cost)"],
  ["^*a", "repeated anchor: RE2 accepts it, JavaScript and PCRE2 refuse it"],
  ["\\b+a", "repeated assertion: RE2 accepts it, JavaScript and PCRE2 refuse it"],
  ["*a", "nothing to repeat"],
  ["a|*", "nothing to repeat"],
  ["(|+)", "nothing to repeat"],
  ["(*LF)a", "PCRE2 start-of-pattern option; errors in JavaScript and RE2"],
  ["(?i)admin", "inline flags"],
  ["(?:a)", "all (? groups are refused; plain parentheses group"],
  ["(?=a)", "lookahead: RE2 has none"],
  ["(?<=a)b", "lookbehind: RE2 has none"],
  ["(?P<n>a)", "named group: JavaScript has no (?P<"],
  ["(?<n>a)\\k<n>", "named group and backreference"],
  ["(a)\\1", "backreference: RE2 has none; JavaScript reads a missing group as octal"],
  ["(a", "unbalanced parenthesis"],
  ["a)", "unbalanced parenthesis"],
  ["(()", "unbalanced parenthesis"],
  ["\\s", "\\s: JavaScript and PCRE2 include \\x0b, RE2 does not; JavaScript also 0xa0"],
  ["\\S", "\\S: JavaScript and PCRE2 exclude \\x0b, RE2 does not; JavaScript also 0xa0"],
  ["\\v", "PCRE2 reads \\v as any vertical space; JavaScript and RE2 as \\x0b"],
  ["\\z", "end of subject in PCRE2 and RE2, the letter z in JavaScript"],
  ["\\Z", "end or before a final newline in PCRE2, the letter Z in JavaScript, an error in RE2"],
  ["\\Aa", "start of subject in PCRE2 and RE2, the letter A in JavaScript"],
  ["\\Qa.b\\E", "quoting in PCRE2 and RE2, the letters Q and E in JavaScript"],
  ["\\p{L}", "Unicode property: PCRE2 over bytes, RE2 over code points, letters in JavaScript"],
  ["\\x{41}", "A in PCRE2 and RE2; x repeated 41 times in JavaScript"],
  ["\\x1", "one hex digit: 0x01 in PCRE2, x1 in JavaScript, an error in RE2"],
  ["\\x", "no hex digits: the letter x in JavaScript, an error in PCRE2 and RE2"],
  ["\\xe9", "above \\x7f: a byte in PCRE2 and JavaScript, a code point in RE2"],
  ["\\u0041", "JavaScript only"],
  ["\\0", "NUL in JavaScript, octal in PCRE2 and RE2"],
  ["\\101", "octal in PCRE2 and RE2, octal or a backreference in JavaScript"],
  ["\\8", "the digit 8 in JavaScript, an error in PCRE2 and RE2"],
  ["\\a", "BEL in PCRE2 and RE2, the letter a in JavaScript"],
  ["\\e", "ESC in PCRE2, the letter e in JavaScript, an error in RE2"],
  ["\\cA", "control-A in JavaScript and PCRE2, an error in RE2"],
  ["\\K", "PCRE2 only (reset match start); the letter K in JavaScript"],
  ["\\C", "PCRE2 only (one code unit); the letter C in JavaScript"],
  ["\\N", "PCRE2 only (not a newline); the letter N in JavaScript"],
  ["\\R", "PCRE2 only (any newline); the letter R in JavaScript"],
  ["\\h", "PCRE2 only (horizontal space); the letter h in JavaScript"],
  ["\\X", "PCRE2 only (grapheme cluster); the letter X in JavaScript"],
  ["\\G", "PCRE2 only (match start); the letter G in JavaScript"],
  ["\\q", "unknown escape: the letter q in JavaScript, an error in PCRE2 and RE2"],
  ["a\\", "trailing backslash"],
  ["[]a]", "JavaScript: an empty class, then a]; PCRE2 and RE2: ] or a"],
  ["[^]a]", "JavaScript: any character, then a]; PCRE2 and RE2: neither ] nor a"],
  ["[^]", "any character in JavaScript, unterminated in PCRE2 and RE2"],
  ["[[:alpha:]]", "POSIX class in PCRE2 and RE2; [, :, a, l, p, h, then ] in JavaScript"],
  ["[:alpha:]", "PCRE2 refuses POSIX syntax outside a class; JavaScript and RE2 read a class"],
  ["[::]", "PCRE2 refuses POSIX syntax outside a class; JavaScript and RE2 read a class"],
  ["[:\\:]", "PCRE2 reads [:...:] as POSIX syntax even with an escaped last :"],
  ["[.a.]", "PCRE2 refuses collating elements; JavaScript and RE2 read a class"],
  ["[=a=]", "PCRE2 refuses equivalence classes; JavaScript and RE2 read a class"],
  ["[\\d-z]", "class escape as a range end: an error in PCRE2, a union in JavaScript and RE2"],
  ["[a-\\w]", "class escape as a range end: an error in PCRE2, a union in JavaScript and RE2"],
  ["[a-b-c]", "a bare - is literal only first or last in a class"],
  ["[--a]", "a bare - is literal only first or last in a class"],
  ["[z-a]", "reversed range"],
  ["[\\b]", "backspace in JavaScript and PCRE2, an error in RE2"],
  ["[\\s]", "\\s differs, as outside a class"],
  ["[a-]]", "unescaped ] outside a class: literal only by engine leniency"],
  ["[a", "unterminated class"],
  ["é", "non-ASCII: one character in JavaScript, two bytes in PCRE2, one code point in RE2"],
  ["a\tb", "control character: write \\t"],
  ["a".repeat(257), "longer than 256 characters"],
];
// Rejected patterns on tls.ja4 (field, reason, pattern).
const rejectedJa4 = [
  ["(?i)^T13", "inline flags"],
  ["^t13\\s", "\\s differs between engines"],
];
const field = "http.request.uri.path";
const accepted = ([source, request, expected, phase = "waf-custom", action]) => {
  const vector = {
    source,
    phase,
    request,
    expected,
    lists: { "list-1": ["192.0.2.0/24"] },
    ir: bindLists(parseExpression(source, phase), { blocked: "list-1" }),
  };
  if (action && !validActionIr(phase, action)) throw new Error(`action refused: ${source}`);
  if (!validExpressionIr(vector.ir, phase)) throw new Error(`IR refused: ${source}`);
  return action ? { ...vector, action } : vector;
};
// Expressions the console refuses together with the IR a node must refuse (`value`:
// as a value expression). The IR is what a console without the check would compile.
const n = (op, patch = {}) => ({
  op,
  field: "",
  valueType: "",
  value: "",
  values: [],
  children: [],
  ...patch,
});
const f = (field, valueType = "string") => n("field", { field, valueType });
const c = (value) => n("const", { valueType: "string", value });
const call = (name, valueType, ...children) => n("call", { field: name, valueType, children });
const PATH = f("http.request.uri.path");
const rejectedIr = [
  [
    'regex_replace(http.request.uri.path, "a", "b") eq "x"',
    false,
    n("eq", {
      valueType: "string",
      value: "x",
      children: [call("regex_replace", "string", PATH, c("a"), c("b"))],
    }),
    "regex_replace only in value expressions",
  ],
  [
    'wildcard_replace(http.request.uri.path, "/*", "${1}") eq "x"',
    false,
    n("eq", {
      valueType: "string",
      value: "x",
      children: [call("wildcard_replace", "string", PATH, c("/*"), c("${1}"))],
    }),
    "wildcard_replace only in value expressions",
  ],
  [
    'concat(regex_replace(http.request.uri.path, "a", "b"), regex_replace(http.request.uri.path, "c", "d"))',
    true,
    call(
      "concat",
      "string",
      call("regex_replace", "string", PATH, c("a"), c("b")),
      call("regex_replace", "string", PATH, c("c"), c("d")),
    ),
    "regex_replace at most once per expression",
  ],
  [
    'trim(http.host) eq "a"',
    false,
    n("eq", {
      valueType: "string",
      value: "a",
      children: [call("trim", "string", f("http.host"))],
    }),
    "unknown function",
  ],
  [
    "starts_with(http.host)",
    false,
    call("starts_with", "boolean", f("http.host")),
    "starts_with takes two arguments",
  ],
  [
    "len(ip.src) eq 1",
    false,
    n("eq", {
      valueType: "number",
      value: "1",
      children: [call("len", "number", f("ip.src", "ip"))],
    }),
    "arguments are strings",
  ],
  [
    "len(len(http.host)) eq 1",
    false,
    n("eq", {
      valueType: "number",
      value: "1",
      children: [call("len", "number", call("len", "number", f("http.host")))],
    }),
    "arguments are strings",
  ],
  [
    'regex_replace(http.host, http.request.uri.path, "x")',
    true,
    call("regex_replace", "string", f("http.host"), PATH, c("x")),
    "the pattern is a literal",
  ],
  [
    'regex_replace(http.request.uri.path, "^/a", "${1}")',
    true,
    call("regex_replace", "string", PATH, c("^/a"), c("${1}")),
    "no group 1",
  ],
  [
    'regex_replace(http.request.uri.path, "(?i)a", "b")',
    true,
    call("regex_replace", "string", PATH, c("(?i)a"), c("b")),
    "pattern outside the subset",
  ],
  [
    'wildcard_replace(http.request.uri.path, "*********", "x")',
    true,
    call("wildcard_replace", "string", PATH, c("*********"), c("x")),
    "at most 8 wildcards",
  ],
  [
    'wildcard_replace(http.request.uri.path, "/a\\\\b*", "x")',
    true,
    call("wildcard_replace", "string", PATH, c("/a\\b*"), c("x")),
    "only \\* and \\\\ escapes",
  ],
  [
    'wildcard_replace(http.request.uri.path, "/*", "${2}")',
    true,
    call("wildcard_replace", "string", PATH, c("/*"), c("${2}")),
    "one wildcard, no capture 2",
  ],
  [
    'wildcard_replace(http.request.uri.path, "/*", "x", "i")',
    true,
    call("wildcard_replace", "string", PATH, c("/*"), c("x"), c("i")),
    'the only flag is "s"',
  ],
  [
    "len(lower(upper(lower(upper(http.host))))) eq 1",
    false,
    n("eq", {
      valueType: "number",
      value: "1",
      children: [
        call(
          "len",
          "number",
          call(
            "lower",
            "string",
            call(
              "upper",
              "string",
              call("lower", "string", call("upper", "string", f("http.host"))),
            ),
          ),
        ),
      ],
    }),
    "functions nest at most 4 deep",
  ],
  [
    'concat(http.host) eq "a"',
    false,
    n("eq", {
      valueType: "string",
      value: "a",
      children: [call("concat", "string", f("http.host"))],
    }),
    "concat takes 2-8 arguments",
  ],
  [
    `concat(${Array(9).fill("http.host").join(", ")}) eq "a"`,
    false,
    n("eq", {
      valueType: "string",
      value: "a",
      children: [call("concat", "string", ...Array(9).fill(f("http.host")))],
    }),
    "concat takes 2-8 arguments",
  ],
  [
    'http.response.content_type.media_type eq "text/html"',
    false,
    n("eq", {
      field: "http.response.content_type.media_type",
      valueType: "string",
      value: "text/html",
    }),
    "response fields only in response phases",
  ],
  [
    "lower(http.host) in $blocked",
    false,
    n("in_list", {
      valueType: "string",
      value: "list-1",
      children: [call("lower", "string", f("http.host"))],
    }),
    "lists only with IP fields",
  ],
  [
    'len(http.host) contains "1"',
    false,
    n("contains", {
      valueType: "number",
      value: "1",
      children: [call("len", "number", f("http.host"))],
    }),
    "contains needs a string",
  ],
  [
    "lower(http.host) lt 3",
    false,
    n("lt", {
      valueType: "string",
      value: "3",
      children: [call("lower", "string", f("http.host"))],
    }),
    "ordered comparison needs integers",
  ],
  [
    "lower(http.host) eq 1",
    false,
    n("eq", {
      valueType: "number",
      value: "1",
      children: [call("lower", "number", f("http.host"))],
    }),
    "lower returns a string",
  ],
  ["len(http.host)", true, call("len", "number", f("http.host")), "value expressions are strings"],
  [
    'starts_with(http.host, "a")',
    true,
    call("starts_with", "boolean", f("http.host"), c("a")),
    "value expressions are strings",
  ],
  [
    'http.host lower eq "x"',
    false,
    n("eq", {
      field: "http.host",
      valueType: "string",
      value: "x",
      children: [call("lower", "string", f("http.host"))],
    }),
    "a field or a computed left side, never both",
  ],
  [
    'lower("x" eq "x")',
    false,
    n("eq", {
      valueType: "string",
      value: "x",
      children: [n("const", { valueType: "number", value: "1" })],
    }),
    "constants are strings",
  ],
  [
    'http.request.uri.path eq lower("x")',
    false,
    n("eq", {
      valueType: "string",
      value: "x",
      children: [f("http.request.uri.path"), f("http.host")],
    }),
    "one computed left side",
  ],
];
// rules-v2 actions nodes refuse in that phase (the condition itself is valid).
const rejectedV2Actions = [
  [{ kind: "origin" }, "origin", "an origin action sets something"],
  [{ kind: "origin", originGroup: "API" }, "origin", "groups are lowercase"],
  [{ kind: "origin", hostHeader: "bad host" }, "origin", "invalid Host"],
  [{ kind: "origin", port: 70000 }, "origin", "port out of range"],
  [{ kind: "origin", originGroup: "api" }, "config", "origin actions run in the origin phase"],
  [{ kind: "config", websocket: false }, "cache", "new config fields only in the config phase"],
  [{ kind: "config", ccMaxLevel: "slider" }, "config", "unknown CC level"],
  [{ kind: "config", originReadTimeoutMs: 50 }, "config", "timeouts start at 100 ms"],
  [{ kind: "config", originConnectTimeoutMs: 120001 }, "config", "connect timeout at most 120 s"],
  [{ kind: "config", logSampleRate: 10001 }, "config", "rate in basis points"],
  [{ kind: "compression", compression: ["deflate"] }, "compression", "unknown coding"],
  [{ kind: "compression", compression: ["br", "br"] }, "compression", "codings are unique"],
  [
    { kind: "compression", compression: ["br"] },
    "response-transform",
    "compression rules run in the compression phase",
  ],
  [
    {
      kind: "redirect",
      value: "/a",
      target: parseValueExpression('"/b"', "redirect"),
      statusCode: 301,
    },
    "redirect",
    "a static value or a target, not both",
  ],
  [
    {
      kind: "redirect",
      value: "/a",
      statusCode: 301,
      setQuery: [
        { name: "b", value: "1" },
        { name: "a", value: "2" },
      ],
    },
    "redirect",
    "parameters sorted by name",
  ],
  [
    {
      kind: "redirect",
      value: "/a",
      statusCode: 301,
      setQuery: [{ name: "a", value: "1" }],
      removeQuery: ["a"],
    },
    "redirect",
    "a parameter is set or removed",
  ],
  [
    { kind: "redirect", value: "/a", statusCode: 301, setQuery: [{ name: "a", value: "é" }] },
    "redirect",
    "values are printable ASCII",
  ],
  [
    { kind: "redirect", value: "/a", statusCode: 301, removeQuery: ["a b"] },
    "redirect",
    "invalid parameter name",
  ],
  [
    { kind: "rewrite", target: call("starts_with", "boolean", PATH, c("/")) },
    "request-transform",
    "targets are strings",
  ],
  [
    { kind: "redirect", value: "/a", statusCode: 301, compression: ["br"] },
    "redirect",
    "fields of another kind",
  ],
  [
    { kind: "rewrite", value: "/a", originGroup: "api" },
    "request-transform",
    "fields of another kind",
  ],
];
// Cache rule conditions in their structured form (older nodes) and as expressions.
const structuredCases = [
  [
    { pathPrefixes: ["/static/", "/assets/"], paths: [], extensions: [] },
    ["/static/a.js", "/assets", "/x/static/", "/assets/"],
  ],
  [
    { pathPrefixes: [], paths: ["/index.html", "/"], extensions: [] },
    ["/", "/index.htm", "/index.html"],
  ],
  [
    { pathPrefixes: [], paths: [], extensions: ["jpg", "png"] },
    ["/a/b.PNG", "/a.png/b", "/file.", "/.png", "/a.tar.png", "/png"],
  ],
  [
    { pathPrefixes: ["/img/"], paths: [], extensions: ["webp"] },
    ["/img/a.webp", "/img/a.png", "/x/a.webp"],
  ],
  [{ pathPrefixes: [], paths: [], extensions: [] }, ["/anything", "/"]],
  [{ pathPrefixes: ['/a"b\\c'], paths: [], extensions: [] }, ['/a"b\\c/x', "/a"]],
  [{ pathPrefixes: ["/中文/"], paths: [], extensions: [] }, ["/中文/x", "/中"]],
  [
    { pathPrefixes: ["/p/"], paths: ["/p/exact"], extensions: ["html"] },
    ["/p/exact", "/p/exact.html", "/p/a.html"],
  ],
  [
    { pathPrefixes: ["/p/"], paths: ["/p/exact.html"], extensions: ["html"] },
    ["/p/exact.html", "/p/a.html"],
  ],
];
const derived = [
  ["extension", "/a/b.PNG", "png"],
  ["extension", "/a.b/c", ""],
  ["extension", "/file.", ""],
  ["extension", "/.htaccess", "htaccess"],
  ["extension", "/a.tar.gz", "gz"],
  ["extension", "/", ""],
  ["extension", "", ""],
  ["extension", "/a/b.Jpeg", "jpeg"],
  ["extension", "/a.中", "中"],
  ["media_type", "text/html; charset=utf-8", "text/html"],
  ["media_type", "Application/JSON", "application/json"],
  ["media_type", "  text/plain ;x=y", "text/plain"],
  ["media_type", "text/html;charset=x", "text/html"],
  ["media_type", "", ""],
  ["media_type", "image/svg+xml", "image/svg+xml"],
];
const derive = { extension: pathExtension, media_type: mediaType };
const vectors = [
  ...cases.map(accepted),
  ...valueCases().map(([source, request, expected, phase = "redirect"]) => {
    const ir = parseValueExpression(source, phase);
    if (evaluateValue(ir, request) !== expected) throw new Error(`value mismatch: ${source}`);
    if (!validExpressionIr(ir, phase, true)) throw new Error(`value IR refused: ${source}`);
    return { source, phase, request, lists: {}, ir, value: true, expected };
  }),
  ...rejectedIr.map(([source, value, ir, reason]) => {
    const phase = "waf-custom";
    const valuePhase = "redirect";
    try {
      if (value) parseValueExpression(source, valuePhase);
      else parseExpression(source, phase);
    } catch {
      if (validExpressionIr(ir, value ? valuePhase : phase, value))
        throw new Error(`IR not rejected: ${source}`);
      return {
        source,
        phase: value ? valuePhase : phase,
        rejected: true,
        irRejected: true,
        ...(value ? { value: true } : {}),
        reason,
        ir,
      };
    }
    throw new Error(`not rejected: ${source}`);
  }),
  ...rejectedV2Actions.map(([action, phase, reason]) => {
    if (validActionIr(phase, action)) throw new Error(`action not rejected: ${reason}`);
    return {
      ...accepted(['http.request.uri.path eq "/"', { "http.request.uri.path": "/" }, true, phase]),
      action,
      actionRejected: true,
      reason,
    };
  }),
  ...structuredCases.flatMap(([structured, paths]) => {
    const source = cacheConditionExpression(structured);
    const ir = parseExpression(source, "cache", { maxLength: 16384 });
    const back = structuredCacheCondition(ir);
    const sorted = {
      ...structured,
      paths: [...structured.paths].sort(),
      extensions: [...structured.extensions].sort(),
    };
    if (!isDeepStrictEqual(back, sorted)) throw new Error(`structured form lost: ${source}`);
    return paths.map((p) => {
      const request = {
        "http.request.uri.path": p,
        "http.request.uri.path.extension": pathExtension(p),
      };
      const expected = structuredCacheMatch(structured, p);
      if (evaluate(ir, request) !== expected) throw new Error(`cache mismatch: ${source} ${p}`);
      return { source, phase: "cache", request, lists: {}, ir, expected, structured };
    });
  }),
  ...derived.map(([kind, input, expected]) => {
    if (derive[kind](input) !== expected) throw new Error(`derive mismatch: ${kind} ${input}`);
    return { derive: kind, input, expected };
  }),
  ...rejectedActions.map(([source, request, expected, phase, action, reason]) => {
    if (validActionIr(phase, action)) throw new Error(`action not rejected: ${source}`);
    return {
      ...accepted([source, request, expected, phase]),
      action,
      actionRejected: true,
      reason,
    };
  }),
  ...[
    ...rejected.map(([pattern, reason]) => [field, pattern, reason]),
    ...rejectedJa4.map(([pattern, reason]) => ["tls.ja4", pattern, reason]),
  ].map(([field, pattern, reason]) => {
    const source = `${field} matches ${JSON.stringify(pattern)}`;
    try {
      parseExpression(source);
    } catch {
      const ir = {
        op: "matches",
        field,
        valueType: "string",
        value: pattern,
        values: [],
        children: [],
      };
      return { source, phase: "waf-custom", rejected: true, reason, ir };
    }
    throw new Error(`not rejected: ${source}`);
  }),
];
writeFileSync(
  new URL("../test/vectors.json", import.meta.url),
  JSON.stringify(vectors, null, 2) + "\n",
);
