// Writes helpers/certd/catalog.json from the DNS provider catalog, the one
// definition shared by the console and edgeweir-certd. A contract test fails
// when the committed file differs (compared as JSON; biome formats it).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dnsProviderCatalog } from "../src/dns-providers.ts";

const target = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../helpers/certd/catalog.json",
);
writeFileSync(target, `${JSON.stringify(dnsProviderCatalog, null, 2)}\n`);
execFileSync("pnpm", ["exec", "biome", "format", "--write", target], { stdio: "inherit" });
console.log(`wrote ${target}`);
