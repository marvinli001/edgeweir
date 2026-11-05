import { createHash } from "node:crypto";
import { extensionManifest } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { kid, PUBLIC_JWK, signPackage, ustar } from "./extension-fixtures";

export function nodeExtensionManifest(
  id: string,
  version = "1.0.0",
  change: Record<string, unknown> = {},
) {
  return {
    format: "edgeweir-node-extension-v1",
    id,
    version,
    publisher: "example.org",
    name: { en: "Node status" },
    requires: { lua_api: 2 },
    scope: "node",
    hooks: ["init", "listen"],
    config: {
      global: {
        type: "object",
        properties: { label: { type: "string", default: "status" } },
      },
    },
    listeners: [{ name: "status", default_port: 9145, methods: ["GET"], max_body: 0 }],
    ...change,
  };
}

/** A future node-scope installation, seeded without changing any existing package version. */
export async function seedNodeExtension(
  db: Database,
  id: string,
  versions: Record<string, unknown>[] = [{}],
) {
  const packages = versions.map((change, i) => {
    const raw = nodeExtensionManifest(id, `1.0.${i}`, change);
    const bytes = ustar({
      "manifest.json": JSON.stringify(raw),
      "lua/main.lua": "return {init=function(ew) end, listen=function(ew) end}",
    });
    return {
      extensionId: id,
      version: raw.version,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      package: bytes,
      signature: signPackage(bytes, raw),
      kid: kid(JSON.parse(PUBLIC_JWK).x),
      manifest: extensionManifest.parse(raw) as unknown as Record<string, unknown>,
    };
  });
  await db.insert(schema.extension).values({
    id,
    activeVersion: "1.0.0",
    config: { label: "status" },
  });
  await db.insert(schema.extensionVersion).values(packages);
  return packages;
}
