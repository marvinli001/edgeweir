import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultMigrationsFolder } from "../src/migrate";

// 0038 removes PEM blocks other than certificates from stored chains: a
// combined fullchain-and-key upload had put the private key there (audit
// 2026-10-01 P1-24).

function migrationsUntil(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), "edgeweir-migrations-"));
  cpSync(defaultMigrationsFolder, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === tag) + 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

const block = (label: string, body: string) =>
  `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
const leaf = block("CERTIFICATE", "TEVBRg==");
const issuer = block("CERTIFICATE", "SVNTVUVS\nTU9SRQ==");
const key = block("PRIVATE KEY", "S0VZ");

const client = new PGlite();
const db = drizzle({ client });
const before = migrationsUntil("0037_dns_cluster_bindings");

beforeAll(async () => {
  await migrate(db, { migrationsFolder: before, migrationsSchema: "drizzle" });
  await client.query(
    `insert into certificate (id, name, source, chain_pem) values
      ('00000000-0000-4000-8000-000000000001', 'combined', 'upload', $1),
      ('00000000-0000-4000-8000-000000000002', 'clean', 'upload', $2),
      ('00000000-0000-4000-8000-000000000003', 'pending', 'acme', '')`,
    [`${leaf}${issuer}${key}`, `subject=CN=x\n${leaf}${issuer}`],
  );
  await migrate(db, { migrationsFolder: defaultMigrationsFolder, migrationsSchema: "drizzle" });
});
afterAll(async () => {
  await client.close();
  rmSync(before, { recursive: true, force: true });
});

describe("0038_certificate_chains", () => {
  it("keeps only the certificates of a chain that holds other PEM blocks", async () => {
    const rows = (
      await client.query<{ name: string; chain_pem: string }>(
        "select name, chain_pem from certificate order by id",
      )
    ).rows;
    expect(rows).toEqual([
      { name: "combined", chain_pem: `${leaf}${issuer}` },
      { name: "clean", chain_pem: `subject=CN=x\n${leaf}${issuer}` },
      { name: "pending", chain_pem: "" },
    ]);
  });
});
