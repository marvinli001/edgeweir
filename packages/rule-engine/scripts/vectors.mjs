import { writeFileSync } from "node:fs";
import { bindLists, parseExpression } from "../src/index.ts";

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
];
const vectors = cases.map(([source, request, expected, phase = "waf-custom"]) => ({
  source,
  phase,
  request,
  expected,
  lists: { "list-1": ["192.0.2.0/24"] },
  ir: bindLists(parseExpression(source, phase), { blocked: "list-1" }),
}));
writeFileSync(
  new URL("../test/vectors.json", import.meta.url),
  JSON.stringify(vectors, null, 2) + "\n",
);
