import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseErrorHint, waitForDatabase } from "../../src/server/bootstrap";
import { CertificateAuthority, generateCa } from "../../src/server/pki/ca";

/**
 * Answers PostgreSQL's SSLRequest with "S", completes the TLS handshake with `cert` (the leaf
 * only, as a server whose CA the client does not know) and hangs up.
 */
async function tlsOnlyPostgres(cert: { certificatePem: string; privateKeyPem: string }) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("data", () => {
      socket.write("S");
      const secure = new tls.TLSSocket(socket, {
        isServer: true,
        cert: cert.certificatePem,
        key: cert.privateKeyPem,
      });
      secure.on("error", () => {});
      secure.on("secure", () => secure.destroy());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The error of a first query through a pool for `url`. */
async function queryError(url: string): Promise<unknown> {
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    await pool.query("select 1");
    return undefined;
  } catch (error) {
    return error;
  } finally {
    await pool.end();
  }
}

describe("waiting for the database", () => {
  let folder: string;
  let caFile: string;
  let trusted: Awaited<ReturnType<typeof tlsOnlyPostgres>>;
  let misnamed: Awaited<ReturnType<typeof tlsOnlyPostgres>>;
  const url = (port: number, query: string) =>
    `postgres://edgeweir:hunter2@127.0.0.1:${port}/edgeweir?${query}`;

  beforeAll(async () => {
    const ca = await CertificateAuthority.load(await generateCa("Test Database CA"));
    folder = await mkdtemp(join(tmpdir(), "edgeweir-db-tls-"));
    caFile = join(folder, "ca.pem");
    await writeFile(caFile, ca.certificatePem);
    // node-postgres checks names against "localhost" when DATABASE_URL names an IP address.
    trusted = await tlsOnlyPostgres(await ca.issueServerCertificate(["localhost", "127.0.0.1"]));
    misnamed = await tlsOnlyPostgres(await ca.issueServerCertificate(["db.example"]));
  });
  afterAll(async () => {
    await Promise.all([trusted.close(), misnamed.close()]);
    await rm(folder, { recursive: true, force: true });
  });

  it("points at sslmode when node-postgres refuses the server certificate for sslmode=require", async () => {
    const warnings: [string, Record<string, unknown> | undefined][] = [];
    const pool = new pg.Pool({ connectionString: url(trusted.port, "sslmode=require") });
    try {
      await expect(
        waitForDatabase(pool, { warn: (msg, fields) => warnings.push([msg, fields]) }, 300),
      ).rejects.toMatchObject({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
    } finally {
      await pool.end();
    }
    expect(warnings[0]).toEqual([
      "database not reachable yet",
      {
        attempt: 1,
        error: expect.stringContaining("unable to verify the first certificate"),
        hint: expect.stringMatching(
          /sslmode=require.*sslrootcert=.*uselibpqcompat=true&sslmode=require.*sslmode=no-verify/,
        ),
      },
    ]);
    // Never DATABASE_URL or its password.
    expect(JSON.stringify(warnings)).not.toMatch(/hunter2|postgres:\/\//);
  });

  it("gives the hint for certificate errors only, and the options it names get past them", async () => {
    // prefer and verify-ca are verify-full too, unless uselibpqcompat=true.
    for (const query of ["sslmode=prefer", "sslmode=verify-ca", "sslmode=verify-full"]) {
      const error = await queryError(url(trusted.port, query));
      expect(error, query).toMatchObject({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
      expect(databaseErrorHint(error), query).toContain("sslmode");
    }
    const altnames = await queryError(url(misnamed.port, `sslmode=require&sslrootcert=${caFile}`));
    expect(altnames).toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    expect(databaseErrorHint(altnames)).toContain("sslmode");
    // Past the handshake the server hangs up: an error, but none about the certificate.
    for (const query of [
      `sslmode=require&sslrootcert=${caFile}`,
      "uselibpqcompat=true&sslmode=require",
      "sslmode=no-verify",
    ]) {
      const error = await queryError(url(trusted.port, query));
      expect(error, query).toBeInstanceOf(Error);
      expect((error as Error).message, query).not.toMatch(/certificate/);
      expect(databaseErrorHint(error), query).toBeUndefined();
    }
  });

  it("tells certificate errors by their Node.js code", () => {
    for (const code of [
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "CERT_HAS_EXPIRED",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ])
      expect(databaseErrorHint(Object.assign(new Error("x"), { code })), code).toContain("sslmode");
    for (const error of [
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }),
      Object.assign(new Error('password authentication failed for user "edgeweir"'), {
        code: "28P01",
      }),
      new Error("Connection terminated unexpectedly"),
      null,
      undefined,
    ])
      expect(databaseErrorHint(error)).toBeUndefined();
  });
});
