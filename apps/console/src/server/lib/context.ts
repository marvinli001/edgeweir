import type { Database } from "@edgeweir/db";
import type pg from "pg";
import type { CertificateAuthority } from "../pki/ca";
import type { AccessKeyRateLimiter } from "../services/access-keys";
import type { SshInstallRuns } from "../services/ssh-install";
import type { Auth } from "./auth";
import type { AddressResolver } from "./dns-check";
import type { Env } from "./env";
import type { MasterKey } from "./envelope";
import type { ConfigEventBus } from "./events";
import type { Logger } from "./logger";

/** Process-wide dependencies shared by the HTTP app, node channel and workers. */
export interface AppContext {
  env: Env;
  db: Database;
  pool: pg.Pool;
  auth: Auth;
  masterKey: MasterKey;
  nodeCa: CertificateAuthority;
  events: ConfigEventBus;
  log: Logger;
  /** AccessKey request counts (services/access-keys); tests replace its clock. */
  accessKeyLimits: AccessKeyRateLimiter;
  /** SSH install runs, in memory only (ADR-0066). */
  sshInstalls: SshInstallRuns;
  /** DNS lookups of the HTTP-01 check (lib/dns-check); the system's resolvers unless set (tests). */
  resolver?: AddressResolver;
}
