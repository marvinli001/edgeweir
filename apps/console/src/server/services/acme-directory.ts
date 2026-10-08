import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import https from "node:https";
import { rootCertificates } from "node:tls";
import {
  type AcmeCa,
  type AcmeDirectoryInput,
  type AcmeDirectorySetting,
  CLIENT_CA_MAX_BYTES,
} from "@edgeweir/contract";
import * as z from "zod";
import type { AppContext } from "../lib/context";
import { CAA_ISSUERS } from "../lib/dns-check";
import { fail } from "../lib/errors";
import type { Actor } from "./audit";
import type { Executor } from "./revisions";
import { defineSetting } from "./settings";

/** The directories of the built-in certificate authorities. */
export const ACME_CA_DIRECTORIES = {
  letsencrypt: "https://acme-v02.api.letsencrypt.org/directory",
  zerossl: "https://acme.zerossl.com/v2/DV90",
  google: "https://dv.acme-v02.api.pki.goog/directory",
} as const satisfies Record<Exclude<AcmeCa, "custom">, string>;

export const ACME_DIRECTORY_KEY = "acme_directory";
/** The custom directory's EAB HMAC key, sealed (system_setting.acme_directory). */
export const acmeDirectoryBinding = {
  purpose: "system_setting.acme_directory",
  recordId: ACME_DIRECTORY_KEY,
};

/** The saved custom directory; an empty URL when none is saved. */
const acmeDirectorySetting = defineSetting({
  key: ACME_DIRECTORY_KEY,
  schema: z.object({
    url: z.string(),
    eabKid: z.string(),
    /** JSON envelope of the EAB HMAC key; empty without EAB. */
    envelope: z.string(),
    caPem: z.string(),
    caaIdentities: z.array(z.string()),
  }),
  defaults: { url: "", eabKid: "", envelope: "", caPem: "", caaIdentities: [] },
  auditAction: "system.acme_directory_update",
});

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * CA certificates of an ACME directory or a client CA bundle: 1-10 readable
 * PEM certificates and nothing else, re-encoded; undefined otherwise.
 */
export function readPemCertificates(pem: string, opts: { ca?: boolean } = {}) {
  if (Buffer.byteLength(pem) > CLIENT_CA_MAX_BYTES) return undefined;
  const labels = [...pem.matchAll(/-----BEGIN ([^\r\n]*?)-----/g)].map((m) => m[1]);
  const blocks = pem.match(PEM_CERTIFICATE) ?? [];
  if (!blocks.length || blocks.length > 10 || labels.some((label) => label !== "CERTIFICATE"))
    return undefined;
  try {
    const certificates = blocks.map((block) => new X509Certificate(block));
    if (opts.ca && certificates.some((cert) => !cert.ca)) return undefined;
    return certificates;
  } catch {
    return undefined;
  }
}

/** The custom directory in effect: each value saved, else from the environment, else none. */
export interface CustomAcmeDirectory {
  url: string;
  source: "setting" | "environment";
  /** CA certificates to trust besides the system roots; empty: the system roots only. */
  caPem: string;
  caSource: "setting" | "environment" | "default";
  eab?: { kid: string; hmacKey: string };
  /** CAA issuer domains from the directory's meta; empty: CAA is not checked. */
  caaIdentities: string[];
}

async function environmentCa(app: AppContext): Promise<string> {
  return app.env.EDGEWEIR_ACME_CA_FILE ? await readFile(app.env.EDGEWEIR_ACME_CA_FILE, "utf8") : "";
}

/**
 * The custom ACME directory (ca "custom"), or undefined when neither the
 * system settings nor EDGEWEIR_ACME_DIRECTORY name one. The CA
 * certificates are the saved ones, else EDGEWEIR_ACME_CA_FILE's.
 */
export async function customAcmeDirectory(
  app: AppContext,
  db: Executor = app.db,
): Promise<CustomAcmeDirectory | undefined> {
  const saved = await acmeDirectorySetting.read(db);
  const url = saved.url || app.env.EDGEWEIR_ACME_DIRECTORY;
  if (!url) return undefined;
  const envCa = saved.caPem ? "" : await environmentCa(app);
  return {
    url,
    source: saved.url ? "setting" : "environment",
    caPem: saved.caPem || envCa,
    caSource: saved.caPem ? "setting" : envCa ? "environment" : "default",
    ...(saved.url && saved.eabKid && saved.envelope
      ? {
          eab: {
            kid: saved.eabKid,
            hmacKey: app.masterKey
              .open(JSON.parse(saved.envelope), acmeDirectoryBinding)
              .toString("utf8"),
          },
        }
      : {}),
    caaIdentities: saved.url ? saved.caaIdentities : [],
  };
}

/** The CA of a request without one: custom while the custom URL comes from the environment. */
export async function defaultAcmeCa(app: AppContext, db: Executor = app.db) {
  const saved = await acmeDirectorySetting.read(db);
  return !saved.url && app.env.EDGEWEIR_ACME_DIRECTORY
    ? ("custom" as const)
    : ("letsencrypt" as const);
}

/**
 * Where an issuance of `ca` goes: the directory, the CA certificates certd
 * trusts besides the system roots, and the custom directory's EAB key. A
 * custom request without a configured directory throws (the caller records
 * acme_directory_not_configured).
 */
export async function issuanceDirectory(
  app: AppContext,
  ca: string | undefined,
  db: Executor = app.db,
): Promise<{ url: string; rootCa?: string; eab?: { kid: string; hmacKey: string } } | undefined> {
  if (ca === "custom") {
    const custom = await customAcmeDirectory(app, db);
    if (!custom) return undefined;
    return { url: custom.url, rootCa: custom.caPem || undefined, eab: custom.eab };
  }
  const builtIn = ca === "zerossl" || ca === "google" ? ca : "letsencrypt";
  return { url: ACME_CA_DIRECTORIES[builtIn] };
}

/** The CA certificates certd trusts for a directory an earlier attempt used (renewal info). */
export async function directoryRootCa(app: AppContext, url: string, db: Executor = app.db) {
  const custom = await customAcmeDirectory(app, db);
  return custom && custom.url === url && custom.caPem ? custom.caPem : undefined;
}

/** The CA of a stored directory URL: built-in, custom (the one in effect), else null. */
export function directoryCa(url: string, custom: string | undefined): AcmeCa | null {
  for (const [ca, directory] of Object.entries(ACME_CA_DIRECTORIES))
    if (directory === url) return ca as AcmeCa;
  return custom === url ? "custom" : null;
}

/** The CAA issuer domains of `ca`; undefined: CAA is not checked. */
export async function caaIssuers(app: AppContext, ca: AcmeCa, db: Executor = app.db) {
  if (ca !== "custom") return CAA_ISSUERS[ca];
  const custom = await customAcmeDirectory(app, db);
  return custom?.caaIdentities.length ? custom.caaIdentities : undefined;
}

const DIRECTORY_LIMIT = 1024 * 1024;

/**
 * Reads an ACME directory (RFC 8555 7.1.1) over HTTPS, trusting the system
 * roots and `caPem`: 10 seconds, at most 1 MiB, no redirects. Returns its
 * `meta.caaIdentities` (RFC 8555 7.1.1, lowercase names); throws when it is
 * unreachable or not a directory.
 */
export async function readAcmeDirectory(url: string, caPem: string): Promise<string[]> {
  const ca = caPem ? [...rootCertificates, caPem] : undefined;
  const body = await new Promise<string>((resolve, reject) => {
    const request = https.get(
      url,
      { ca, timeout: 10_000, headers: { accept: "application/json" } },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`status ${response.statusCode}`));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > DIRECTORY_LIMIT) {
            request.destroy(new Error("directory too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        response.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    setTimeout(() => request.destroy(new Error("timeout")), 10_000).unref();
  });
  const directory = JSON.parse(body) as Record<string, unknown>;
  for (const field of ["newNonce", "newAccount", "newOrder"])
    if (typeof directory[field] !== "string") throw new Error(`no ${field}`);
  const meta = directory.meta as { caaIdentities?: unknown } | undefined;
  const identities = Array.isArray(meta?.caaIdentities) ? meta.caaIdentities : [];
  return [
    ...new Set(
      identities
        .filter(
          (name): name is string => typeof name === "string" && /^[a-z0-9.-]{1,253}$/i.test(name),
        )
        .map((name) => name.toLowerCase()),
    ),
  ].slice(0, 10);
}

/** The setting with each value's source; never the EAB HMAC key. */
export async function getAcmeDirectory(app: AppContext): Promise<AcmeDirectorySetting> {
  const saved = await acmeDirectorySetting.read(app.db);
  const custom = await customAcmeDirectory(app);
  return {
    url: saved.url,
    effectiveUrl: custom?.url ?? "",
    source: custom?.source ?? "default",
    eabKid: saved.url ? saved.eabKid : "",
    eabHmacKeySet: !!(saved.url && saved.eabKid && saved.envelope),
    caPem: saved.caPem,
    caSource: custom?.caSource ?? "default",
    caaIdentities: custom?.caaIdentities ?? [],
  };
}

/**
 * Saves the custom ACME directory after reading it with the CA
 * certificates it will be used with (ACME_DIRECTORY_INVALID); an empty URL
 * removes the setting. The EAB HMAC key is sealed; an empty one keeps the
 * saved key of the same key id (ACME_DIRECTORY_EAB_INCOMPLETE without one).
 * The directory may be on a private network (private CAs, test
 * directories): it is the operator's, and its responses are never shown.
 */
export async function setAcmeDirectory(
  app: AppContext,
  input: AcmeDirectoryInput,
  actor: Actor,
): Promise<AcmeDirectorySetting> {
  if (!input.url) {
    await app.db.transaction((tx) =>
      acmeDirectorySetting.write(tx, actor, null, {
        metadata: (before) => ({ before: before.url, after: "" }),
      }),
    );
    return getAcmeDirectory(app);
  }
  let caPem = "";
  if (input.caPem.trim()) {
    const certificates = readPemCertificates(input.caPem);
    if (!certificates)
      fail("ACME_DIRECTORY_CA_INVALID", "the CA certificates must be 1 to 10 PEM certificates");
    caPem = certificates.map((cert) => cert.toString()).join("");
  }
  const saved = await acmeDirectorySetting.read(app.db);
  let envelope = "";
  if (input.eabKid) {
    if (input.eabHmacKey)
      envelope = JSON.stringify(app.masterKey.seal(input.eabHmacKey, acmeDirectoryBinding));
    else if (saved.url && saved.eabKid === input.eabKid && saved.envelope)
      envelope = saved.envelope;
    else fail("ACME_DIRECTORY_EAB_INCOMPLETE", "supply the EAB HMAC key with its key id");
  }
  let caaIdentities: string[];
  try {
    caaIdentities = await readAcmeDirectory(input.url, caPem || (await environmentCa(app)));
  } catch (error) {
    app.log.info("ACME directory refused", {
      url: input.url,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return fail("ACME_DIRECTORY_INVALID", "the URL does not answer with an ACME directory");
  }
  await app.db.transaction((tx) =>
    acmeDirectorySetting.write(
      tx,
      actor,
      { url: input.url, eabKid: input.eabKid, envelope, caPem, caaIdentities },
      {
        metadata: (before) => ({
          before: before.url,
          after: input.url,
          eabKid: input.eabKid,
          caCertificates: !!caPem,
        }),
      },
    ),
  );
  return getAcmeDirectory(app);
}
