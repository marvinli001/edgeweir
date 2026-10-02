// Account recovery from the server, bundled to dist/server/recover.js:
// `docker compose exec console node dist/server/recover.js --help`.
import { createDatabase } from "@edgeweir/db";
import { createAuth } from "./lib/auth";
import { loadAuthSecret } from "./lib/auth-secret";
import { loadEnv } from "./lib/env";
import { MasterKey } from "./lib/envelope";
import { runRecover } from "./recover-cli";

process.exitCode = await runRecover(process.argv.slice(2), process, async () => {
  const env = loadEnv();
  const { db, pool } = createDatabase(
    env.DATABASE_URL,
    (error) => process.stderr.write(`database connection lost: ${error.message}\n`),
    2,
  );
  const masterKey = new MasterKey(env.EDGEWEIR_MASTER_KEY, env.EDGEWEIR_MASTER_KEY_PREVIOUS);
  // The secret the console runs with, also after a master key rotation.
  const secret = await loadAuthSecret(db, env, masterKey).catch(async (error: unknown) => {
    await pool.end();
    throw error;
  });
  const auth = createAuth({ db, secret: secret.value, publicUrl: env.EDGEWEIR_PUBLIC_URL });
  return { db, auth, close: () => pool.end() };
});
