import {
  demoCidr,
  forbiddenOriginRange,
  type LoginAllowList,
  loginAllowListContains,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import * as z from "zod";
import { fail } from "../lib/errors";
import type { Logger } from "../lib/logger";
import type { Actor } from "./audit";
import { normalizeCidrs } from "./origin-allow-list";
import type { Executor } from "./revisions";
import { defineSetting } from "./settings";

/**
 * The networks the operator may sign in from (ADR-0047). Outside them better-auth's endpoints
 * (except sign-out) and session calls of /rpc answer LOGIN_IP_NOT_ALLOWED; AccessKeys and
 * service account keys on /api/v1 and the demo account are not limited. No row: anyone may.
 */
export const LOGIN_ALLOW_LIST_KEY = "login_allow_list";

const loginAllowListSetting = defineSetting({
  key: LOGIN_ALLOW_LIST_KEY,
  schema: z.object({ cidrs: z.unknown().transform(normalizeCidrs) }),
  defaults: { cidrs: [] },
  auditAction: "system.login_allow_list_update",
  targetName: LOGIN_ALLOW_LIST_KEY,
});

/** The allowed CIDRs (normalized, sorted); empty when the list is off. */
export async function loadLoginAllowList(db: Executor): Promise<string[]> {
  return (await loginAllowListSetting.read(db)).cidrs;
}

/**
 * Whether a request from `ip` may sign in or use a session: the list is off or contains it.
 * Read on every call, so a change (or recover.js --clear-login-allowlist) applies at once.
 */
export async function loginAllowed(db: Executor, ip: string): Promise<boolean> {
  const cidrs = await loadLoginAllowList(db);
  return cidrs.length === 0 || loginAllowListContains(cidrs, ip);
}

/** Who asks: the address the console resolved (resolveClientIp) and how it got it. */
export interface LoginCaller {
  ip: string;
  /** The request carried forwarding headers from a peer outside EDGEWEIR_TRUSTED_PROXIES. */
  untrustedForwarding: boolean;
  /** The demo account sees the ranges cut to /24 or /48 (ADR-0045). */
  demo: boolean;
}

function view(cidrs: readonly string[], caller: LoginCaller): LoginAllowList {
  return {
    cidrs: caller.demo ? [...new Set(cidrs.map(demoCidr).filter(Boolean))].sort() : [...cidrs],
    currentIp: caller.ip,
    proxyHint:
      caller.untrustedForwarding ||
      (caller.ip !== "" && forbiddenOriginRange(caller.ip, []) !== null),
  };
}

export async function getLoginAllowList(db: Executor, caller: LoginCaller) {
  return view(await loadLoginAllowList(db), caller);
}

/**
 * Replaces the list (already normalized by the contract) with its audit entry. A list that
 * leaves out the caller's own address is refused, so saving cannot lock the caller out; an
 * empty list removes the setting.
 */
export async function setLoginAllowList(
  db: Database,
  input: { cidrs: string[] },
  actor: Actor,
  caller: LoginCaller,
): Promise<LoginAllowList> {
  const cidrs = [...new Set(input.cidrs)].sort();
  if (cidrs.length > 0 && !loginAllowListContains(cidrs, caller.ip)) {
    fail(
      "LOGIN_ALLOW_LIST_EXCLUDES_CURRENT_IP",
      `the list leaves out ${caller.ip || "the address of this request"}, which would lock you out`,
      { ip: caller.ip },
    );
  }
  const saved = await db.transaction((tx) =>
    loginAllowListSetting.write(tx, actor, cidrs.length > 0 ? { cidrs } : null, {
      metadata: (before) => ({
        cidrs,
        added: cidrs.filter((c) => !before.cidrs.includes(c)),
        removed: before.cidrs.filter((c) => !cidrs.includes(c)),
      }),
    }),
  );
  return view(saved.cidrs, caller);
}

/**
 * Removes the list in the caller's transaction, without an audit entry of its own
 * (recover.js records account.recover). Returns the ranges it held.
 */
export async function clearLoginAllowList(tx: Executor): Promise<string[]> {
  const cidrs = await loadLoginAllowList(tx);
  await tx.delete(schema.systemSetting).where(eq(schema.systemSetting.key, LOGIN_ALLOW_LIST_KEY));
  return cidrs;
}

/** Refused requests are logged, not audited: one line per address and minute, 20 at most. */
const REFUSAL_LOG_WINDOW_MS = 60_000;
const REFUSAL_LOG_LINES = 20;

let refusalWindow = { start: 0, ips: new Set<string>(), suppressed: 0 };

/** Logs a request refused by the login allow list, at most once per address and window. */
export function logLoginRefusal(log: Logger, ip: string, path: string, now = Date.now()): void {
  if (now - refusalWindow.start >= REFUSAL_LOG_WINDOW_MS) {
    refusalWindow = { start: now, ips: new Set(), suppressed: refusalWindow.suppressed };
  }
  if (refusalWindow.ips.has(ip) || refusalWindow.ips.size >= REFUSAL_LOG_LINES) {
    refusalWindow.suppressed++;
    return;
  }
  refusalWindow.ips.add(ip);
  const suppressed = refusalWindow.suppressed;
  refusalWindow.suppressed = 0;
  log.warn("request refused: address outside the login allow list", {
    component: "login-allow-list",
    ip,
    path,
    ...(suppressed > 0 ? { suppressed } : {}),
  });
}
