// Account recovery from the server, bundled to dist/server/recover.js:
// `docker compose exec console node dist/server/recover.js --help`.
import { createDatabase } from "@edgeweir/db";
import { createAuth } from "./lib/auth";
import { resolveAuthSecret } from "./lib/auth-secret";
import { loadEnv } from "./lib/env";
import { runRecover } from "./recover-cli";

process.exitCode = await runRecover(process.argv.slice(2), process, () => {
  const env = loadEnv();
  const { db, pool } = createDatabase(env.DATABASE_URL, 2);
  const auth = createAuth({
    db,
    secret: resolveAuthSecret(env).value,
    publicUrl: env.EDGEWEIR_PUBLIC_URL,
  });
  return { db, auth, close: () => pool.end() };
});
