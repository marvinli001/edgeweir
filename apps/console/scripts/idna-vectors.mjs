// Writes test/server/fixtures/idna-vectors.json, a subset of the official
// UTS #46 conformance data (IdnaTestV2.txt) as site domains read it:
// nontransitional toASCII, then the LDH rules (toAsciiHost in
// src/server/lib/idna.ts).
//   node scripts/idna-vectors.mjs <path to IdnaTestV2.txt>
// Rows whose only errors are V2 (hyphens in the third and fourth position)
// are left out: WHATWG URL, which the console uses, runs with CheckHyphens
// off, and LDH allows such labels (every "xn--" label has them). Every other
// row expects the ASCII form when toAsciiN reports no error and the result
// passes LDH (letters, digits and inner hyphens, labels of 1-63 characters,
// 253 in all, two labels or more), and null otherwise. Rows with code points
// that Unicode 17.0 (tr46 6.0.0) assigned after the data's version are left
// out too (UNASSIGNED_BEFORE_17).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { punycodeDecode } from "../../../packages/contract/src/domains.ts";

const path = process.argv[2];
if (!path) throw new Error("usage: node scripts/idna-vectors.mjs <IdnaTestV2.txt>");
const text = readFileSync(path, "utf8");
const header = (name) => text.match(new RegExp(`^# ${name}: (.+)$`, "m"))?.[1]?.trim();

const unescapeData = (value) =>
  value
    .replace(/\\x\{([0-9A-Fa-f]+)\}/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)));
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const LDH = new RegExp(`^(?:${LABEL}\\.)+${LABEL}$`);
/** The labels of an ASCII name decoded (Punycode), to look for new code points. */
const decoded = (name) =>
  name
    .split(".")
    .map((l) => (l.startsWith("xn--") ? (punycodeDecode(l.slice(4)) ?? "") : l))
    .join(".");
const statuses = (value) =>
  value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// Code points new in Unicode 17.0: CJK Extension J (U+31350-U+323AF) and the
// other 17.0 additions the 16.0 data still calls unassigned (status V7).
const UNASSIGNED_BEFORE_17 = /[\u{31350}-\u{323AF}]/u;
const rows = [];
for (const line of text.split("\n")) {
  const data = line.replace(/#.*$/, "");
  if (!data.trim()) continue;
  const columns = data.split(";").map((c) => c.trim());
  const source = unescapeData(columns[0] === '""' ? "" : columns[0]);
  const toUnicode = columns[1] ? unescapeData(columns[1] === '""' ? "" : columns[1]) : source;
  const unicodeStatus = statuses(columns[2] ?? "");
  const toAscii = columns[3] ? unescapeData(columns[3] === '""' ? "" : columns[3]) : toUnicode;
  const asciiStatus = columns[4] ? statuses(columns[4]) : unicodeStatus;
  if (asciiStatus.length && asciiStatus.every((s) => s === "V2")) continue;
  if (UNASSIGNED_BEFORE_17.test(decoded(toAscii) + source)) continue;
  const ok = asciiStatus.length === 0 && toAscii.length <= 253 && LDH.test(toAscii);
  rows.push({ input: source, ascii: ok ? toAscii : null, status: asciiStatus });
}

// The subset: every accepted row with a non-ASCII source or an xn-- label,
// up to 150, and up to 6 refused rows per error code, in file order.
const accepted = rows
  .filter((r) => r.ascii !== null && (/[^\x20-\x7e]/.test(r.input) || /xn--/i.test(r.input)))
  .slice(0, 150);
const refused = [];
const perCode = new Map();
for (const row of rows) {
  if (row.ascii !== null) continue;
  const code = row.status[0] ?? "LDH";
  const n = perCode.get(code) ?? 0;
  if (n >= 6) continue;
  perCode.set(code, n + 1);
  refused.push(row);
}
const out = {
  source: `IdnaTestV2.txt ${header("Version")} (${header("Date")})`,
  sha256: createHash("sha256").update(text).digest("hex"),
  vectors: [...accepted, ...refused].map(({ input, ascii, status }) => ({
    input,
    ascii,
    ...(status.length ? { status } : {}),
  })),
};
const target = join(
  dirname(fileURLToPath(import.meta.url)),
  "../test/server/fixtures/idna-vectors.json",
);
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(`${target}: ${accepted.length} accepted, ${refused.length} refused`);
