import { createHash, createPublicKey, verify } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  EXTENSION_FORMAT,
  EXTENSION_LIMITS,
  EXTENSION_PUBLISHER_RE,
  EXTENSION_SIDECAR_LIMITS,
  type ExtensionManifest,
  extensionManifest,
} from "@edgeweir/contract";
import { fail } from "./errors";

/**
 * Reading and verifying node extension packages (edgeweir-node-extension-v1,
 * docs/reference/extensions.md): a strict ustar reader over the gunzipped
 * bytes, the manifest rules and the Ed25519 JWS. Nothing in the archive is
 * trusted before the signature and digest check; the node repeats the same
 * checks (internal/extension). Files under sidecar/linux-amd64/ and
 * sidecar/linux-arm64/ are the only native code a package may hold, and only
 * with a manifest `sidecar` (version 1.1), which also raises the size limits.
 */

export interface PackageFile {
  path: string;
  data: Uint8Array;
}

export interface Jwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

export interface VerifiedPackage {
  manifest: ExtensionManifest;
  sha256: string;
  size: number;
  kid: string;
  files: PackageFile[];
}

const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const TOP_LEVEL_FILE_RE = /^(LICENSE|NOTICE|README)[A-Za-z0-9._-]*$/;
const NATIVE_RE = /\.(so|dll|dylib|node|exe|bin)$/i;
/** Sidecar architectures and the ELF e_machine of each. */
const SIDECAR_ARCHES: Record<string, number> = { "linux-amd64": 62, "linux-arm64": 183 };
const isSidecarPath = (path: string) => path.startsWith("sidecar/");
const mib = (bytes: number) => `${bytes / 1024 / 1024} MiB`;

const invalid = (reason: string, detail: string): never =>
  fail("EXTENSION_PACKAGE_INVALID", `invalid extension package: ${detail}`, { reason, detail });

function octal(field: Uint8Array): number {
  const text = new TextDecoder().decode(field).replace(/\0.*$/s, "").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) invalid("archive", "bad numeric field");
  return Number.parseInt(text, 8);
}

function cString(field: Uint8Array): string {
  const end = field.indexOf(0);
  return new TextDecoder("utf-8", { fatal: true }).decode(end < 0 ? field : field.subarray(0, end));
}

function checkPath(path: string): void {
  if (path.length === 0 || new TextEncoder().encode(path).length > EXTENSION_LIMITS.pathBytes)
    invalid("entry", `bad path length: ${path.slice(0, 64)}`);
  const segments = path.split("/");
  for (const segment of segments) {
    if (!SEGMENT_RE.test(segment) || segment === "." || segment === "..")
      invalid("entry", `bad path: ${path}`);
  }
  const top = segments[0] as string;
  if (segments.length === 1) {
    if (path !== "manifest.json" && !TOP_LEVEL_FILE_RE.test(path))
      invalid("entry", `unexpected file: ${path}`);
  } else if (top === "sidecar") {
    // sidecar/<arch>/<binary>; the manifest check follows (checkSidecar).
    if (segments.length !== 3 || !Object.hasOwn(SIDECAR_ARCHES, segments[1] as string))
      invalid("entry", `unexpected file: ${path}`);
    return;
  } else if (top !== "lua" && top !== "assets") {
    invalid("entry", `unexpected directory: ${top}`);
  }
  if (top === "lua" && segments.length > 1 && !path.endsWith(".lua"))
    invalid("entry", `not a Lua module: ${path}`);
  if (NATIVE_RE.test(path)) invalid("entry", `native code: ${path}`);
}

function checkDirectory(path: string): void {
  const segments = path.split("/");
  if (segments.some((s) => !SEGMENT_RE.test(s) || s === "." || s === ".."))
    invalid("entry", `bad path: ${path}`);
  if (segments[0] === "sidecar") {
    if (segments.length > 2 || (segments[1] && !Object.hasOwn(SIDECAR_ARCHES, segments[1])))
      invalid("entry", `unexpected directory: ${path}`);
    return;
  }
  if (segments[0] !== "lua" && segments[0] !== "assets")
    invalid("entry", `unexpected directory: ${segments[0]}`);
}

/**
 * Parses the gunzipped ustar stream: regular files and directories only,
 * within the limits of a package with a sidecar (checkLimits applies the
 * smaller ones of other packages once the manifest is known).
 */
export function readArchive(archive: Uint8Array): PackageFile[] {
  if (archive.length > EXTENSION_SIDECAR_LIMITS.archiveBytes)
    invalid("size", `archive larger than ${mib(EXTENSION_SIDECAR_LIMITS.archiveBytes)}`);
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, {
      maxOutputLength: EXTENSION_SIDECAR_LIMITS.unpackedBytes + 1024 * 1024,
    });
  } catch {
    return invalid("archive", "not a gzip stream within the size limit");
  }
  const files: PackageFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  let entries = 0;
  let paxPath: string | null = null;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const sum = octal(header.subarray(148, 156));
    let computed = 0;
    for (let i = 0; i < 512; i++) computed += i >= 148 && i < 156 ? 32 : (header[i] as number);
    if (sum !== computed) invalid("archive", "bad header checksum");
    const magic = new TextDecoder().decode(header.subarray(257, 262));
    if (magic !== "ustar") invalid("archive", "not a ustar archive");
    const type = String.fromCharCode(header[156] as number);
    const size = octal(header.subarray(124, 136));
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) invalid("archive", "truncated archive");
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (++entries > EXTENSION_LIMITS.entries) invalid("size", "too many entries");
    if (type === "x") {
      // PAX extended header: only a path record is honored.
      const records = new TextDecoder().decode(tar.subarray(dataStart, dataEnd));
      paxPath = null;
      for (const line of records.split("\n")) {
        if (!line) continue;
        const match = /^\d+ ([^=]+)=(.*)$/s.exec(line);
        if (!match) invalid("archive", "bad pax record");
        if (match?.[1] === "path") paxPath = match[2] as string;
        else if (!["mtime", "atime", "ctime"].includes(match?.[1] ?? ""))
          invalid("archive", `unsupported pax record ${match?.[1]}`);
      }
      continue;
    }
    const prefix = cString(header.subarray(345, 500));
    const name = cString(header.subarray(0, 100));
    let path = paxPath ?? (prefix ? `${prefix}/${name}` : name);
    paxPath = null;
    path = path.replace(/^\.\//, "");
    if (type === "5") {
      path = path.replace(/\/$/, "");
      if (path !== "") checkDirectory(path);
      continue;
    }
    if (type !== "0" && type !== "\0") invalid("entry", `not a regular file: ${path}`);
    checkPath(path);
    if (seen.has(path)) invalid("entry", `duplicate entry: ${path}`);
    seen.add(path);
    if (size > EXTENSION_SIDECAR_LIMITS.fileBytes)
      invalid("size", `file larger than ${mib(EXTENSION_SIDECAR_LIMITS.fileBytes)}: ${path}`);
    total += size;
    if (total > EXTENSION_SIDECAR_LIMITS.unpackedBytes)
      invalid("size", `unpacked size larger than ${mib(EXTENSION_SIDECAR_LIMITS.unpackedBytes)}`);
    files.push({ path, data: new Uint8Array(tar.subarray(dataStart, dataEnd)) });
  }
  return files;
}

/** Validates the files of a package and returns its manifest. */
function readManifest(files: PackageFile[]): ExtensionManifest {
  const file = files.find((f) => f.path === "manifest.json");
  if (!file) return invalid("manifest", "manifest.json missing");
  if (file.data.length > EXTENSION_LIMITS.manifestBytes)
    invalid("manifest", "manifest larger than 64 KiB");
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.data));
  } catch {
    return invalid("manifest", "manifest.json is not UTF-8 JSON");
  }
  const parsed = extensionManifest.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return invalid(
      "manifest",
      `${issue?.path.join(".") || "manifest"}: ${issue?.message ?? "invalid"}`,
    );
  }
  if (!files.some((f) => f.path === "lua/main.lua")) invalid("manifest", "lua/main.lua missing");
  for (const f of files) {
    if (!f.path.endsWith(".lua") || isSidecarPath(f.path)) continue;
    if (f.data[0] === 0x1b) invalid("entry", `bytecode: ${f.path}`);
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(f.data);
    } catch {
      invalid("entry", `not UTF-8 text: ${f.path}`);
    }
  }
  return parsed.data;
}

/** The size limits of the package's kind: larger ones with a sidecar. */
function checkLimits(archiveBytes: number, files: PackageFile[], manifest: ExtensionManifest) {
  const limits = manifest.sidecar ? EXTENSION_SIDECAR_LIMITS : EXTENSION_LIMITS;
  if (archiveBytes > limits.archiveBytes)
    invalid("size", `archive larger than ${mib(limits.archiveBytes)}`);
  let total = 0;
  for (const f of files) {
    if (f.data.length > limits.fileBytes)
      invalid("size", `file larger than ${mib(limits.fileBytes)}: ${f.path}`);
    total += f.data.length;
  }
  if (total > limits.unpackedBytes)
    invalid("size", `unpacked size larger than ${mib(limits.unpackedBytes)}`);
}

/** Whether `data` is a 64-bit ELF file for the machine (EI_DATA picks the byte order). */
function isElf64(data: Uint8Array, machine: number): boolean {
  if (data.length < 64) return false;
  if (data[0] !== 0x7f || data[1] !== 0x45 || data[2] !== 0x4c || data[3] !== 0x46) return false;
  if (data[4] !== 2) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data[5] !== 1 && data[5] !== 2) return false;
  return view.getUint16(18, data[5] === 1) === machine;
}

/**
 * Native code: only the manifest's sidecar binary, for at least one of the
 * architectures, as an ELF executable of that architecture.
 */
function checkSidecar(files: PackageFile[], manifest: ExtensionManifest) {
  const native = files.filter((f) => isSidecarPath(f.path));
  if (!manifest.sidecar) {
    const first = native[0];
    if (first) invalid("entry", `native code: ${first.path}`);
    return;
  }
  const { binary } = manifest.sidecar;
  for (const f of native) {
    const [, arch, name] = f.path.split("/") as [string, string, string];
    if (name !== binary) invalid("entry", `unexpected file: ${f.path}`);
    if (!isElf64(f.data, SIDECAR_ARCHES[arch] as number))
      invalid("entry", `not a 64-bit ELF executable for ${arch}: ${f.path}`);
  }
  if (native.length === 0) invalid("manifest", `sidecar/<arch>/${binary} missing`);
}

const b64url = (data: Uint8Array | string) => Buffer.from(data).toString("base64url");

/** RFC 7638 thumbprint of an Ed25519 JWK. */
export function jwkThumbprint(x: string): string {
  return b64url(createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest());
}

/** Parses an operator-supplied public key: JWK JSON or the bare base64url x. */
export function parsePublicKey(input: string): Jwk {
  let x = input.trim();
  if (x.startsWith("{")) {
    let jwk: Record<string, unknown>;
    try {
      jwk = JSON.parse(x);
    } catch {
      return fail("EXTENSION_KEY_INVALID", "not a JWK");
    }
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || "d" in jwk)
      fail("EXTENSION_KEY_INVALID", "not an Ed25519 public JWK");
    x = jwk.x as string;
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(x) || Buffer.from(x, "base64url").length !== 32)
    fail("EXTENSION_KEY_INVALID", "not a 32-byte Ed25519 key");
  return { kty: "OKP", crv: "Ed25519", x };
}

interface SignaturePayload {
  format: string;
  id: string;
  version: string;
  publisher: string;
  sha256: string;
  size: number;
  iat: number;
}

const badSignature = (reason: string): never =>
  fail("EXTENSION_SIGNATURE_INVALID", `invalid extension signature: ${reason}`, { reason });

/** Splits the JWS and checks its header; returns the kid and the payload (not yet verified). */
function parseSignature(jws: string): {
  kid: string;
  payload: SignaturePayload;
  signingInput: string;
  signature: Buffer;
} {
  const parts = jws.trim().split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) badSignature("format");
  const [h, p, s] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return badSignature("format");
  }
  const keys = Object.keys(header).sort().join(",");
  if (
    keys !== "alg,kid,typ" ||
    header.alg !== "EdDSA" ||
    header.typ !== "edgeweir-ext+jws" ||
    typeof header.kid !== "string"
  )
    badSignature("header");
  if (
    payload.format !== EXTENSION_FORMAT ||
    typeof payload.id !== "string" ||
    typeof payload.version !== "string" ||
    typeof payload.publisher !== "string" ||
    typeof payload.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(payload.sha256) ||
    typeof payload.size !== "number" ||
    typeof payload.iat !== "number"
  )
    badSignature("format");
  return {
    kid: header.kid as string,
    payload: payload as unknown as SignaturePayload,
    signingInput: `${h}.${p}`,
    signature: Buffer.from(s, "base64url"),
  };
}

/** Verifies an Ed25519 signature with a JWK x. */
function verifyEd25519(x: string, data: string, signature: Buffer): boolean {
  if (signature.length !== 64) return false;
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
  return verify(null, Buffer.from(data), key, signature);
}

/**
 * Verifies a package and its signature against the trust store: the key
 * must be trusted for the publisher, the signature valid, digest and size
 * those of the bytes, and identity that of the manifest.
 */
export function verifyPackage(
  bytes: Uint8Array,
  jws: string,
  trusted: (kid: string) => { publisher: string; x: string } | undefined,
): VerifiedPackage {
  if (bytes.length > EXTENSION_SIDECAR_LIMITS.archiveBytes)
    invalid("size", `archive larger than ${mib(EXTENSION_SIDECAR_LIMITS.archiveBytes)}`);
  const { kid, payload, signingInput, signature } = parseSignature(jws);
  const key = trusted(kid);
  if (!key) fail("EXTENSION_KEY_UNTRUSTED", "the signing key is not trusted", { kid });
  if (!verifyEd25519((key as { x: string }).x, signingInput, signature)) badSignature("signature");
  if (!EXTENSION_PUBLISHER_RE.test(payload.publisher) || payload.publisher !== key?.publisher)
    fail("EXTENSION_PUBLISHER_MISMATCH", "the package's publisher is not the key's", {
      publisher: payload.publisher,
      keyPublisher: key?.publisher ?? "",
    });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (payload.sha256 !== sha256 || payload.size !== bytes.length) badSignature("digest");
  const files = readArchive(bytes);
  const manifest = readManifest(files);
  checkLimits(bytes.length, files, manifest);
  checkSidecar(files, manifest);
  if (
    manifest.id !== payload.id ||
    manifest.version !== payload.version ||
    manifest.publisher !== payload.publisher
  )
    badSignature("identity");
  return { manifest, sha256, size: bytes.length, kid, files };
}

/** Decodes the base64 package of an API request. */
export function decodePackage(base64: string): Uint8Array {
  const clean = base64.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean)) invalid("archive", "package is not base64");
  return new Uint8Array(
    Buffer.from(clean, clean.includes("-") || clean.includes("_") ? "base64url" : "base64"),
  );
}
