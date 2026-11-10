import { randomBytes, randomUUID } from "node:crypto";
import { bootstrapInput } from "@edgeweir/contract";
import { createDatabase } from "@edgeweir/db";
import { z } from "zod";
import { loadEnvOrExit } from "./lib/env";
import { grantIntegrationAuthorization } from "./services/integration-authorization";

try {
  const mode = z.enum(["prepare", "authorize", "renew"]).parse(process.argv[2]);
  if (mode === "prepare") {
    const installationId = z.uuid().parse(process.argv[3]);
    process.stdout.write(
      JSON.stringify({
        installationId,
        requestId: randomUUID(),
        token: randomBytes(32).toString("base64url"),
      }) + "\n",
    );
  } else {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 4096) throw new Error("invalid private authorization input");
      chunks.push(Buffer.from(chunk));
    }
    const input = bootstrapInput.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const env = loadEnvOrExit();
    const { pool, db } = createDatabase(env.DATABASE_URL, () => {});
    try {
      await grantIntegrationAuthorization(pool, db, input, mode === "renew");
    } finally {
      await pool.end();
    }
  }
} catch (error) {
  process.stderr.write(
    JSON.stringify({
      error:
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "INTEGRATION_AUTHORIZATION_FAILED",
    }) + "\n",
  );
  process.exitCode = 1;
}
