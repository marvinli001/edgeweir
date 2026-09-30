// node --experimental-transform-types scripts/vectors.mjs writes test/vectors.json; copy it to
// edgeweir-node test/lua/expression-vectors.json, then `pnpm exec biome format --write` this copy.
import { writeFileSync } from "node:fs";
import { bindLists, parseExpression, validActionIr } from "../src/index.ts";

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
];

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
  return action ? { ...vector, action } : vector;
};
const vectors = [
  ...cases.map(accepted),
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
