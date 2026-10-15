import {
  type AuditLogEntry,
  DEMO_EMAIL,
  DEMO_PASSWORD,
  DEMO_USER_ID,
  type DemoSettings,
  demoAddress,
  demoCidr,
  type LogEntry,
} from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, eq, ne } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { type Actor, recordAudit } from "./audit";
import type { Executor } from "./revisions";

/** Excludes the demo account from queries for the operator's account. */
export const notDemoUser = ne(schema.user.id, DEMO_USER_ID);

export async function isDemoEnabled(db: Executor): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.id, DEMO_USER_ID));
  return row !== undefined;
}

/**
 * Creates the demo account (DEMO_EMAIL / DEMO_PASSWORD, written directly, so
 * the password policy for chosen passwords does not apply) or deletes it with
 * its sessions. The operator's account is left as it is.
 */
export async function setDemo(
  app: AppContext,
  input: DemoSettings,
  actor: Actor,
): Promise<DemoSettings> {
  const hash = input.enabled ? await (await app.auth.$context).password.hash(DEMO_PASSWORD) : "";
  await app.db.transaction(async (tx) => {
    const before = await isDemoEnabled(tx);
    if (before === input.enabled) return;
    if (input.enabled) {
      const [taken] = await tx
        .select({ id: schema.user.id })
        .from(schema.user)
        .where(and(eq(schema.user.email, DEMO_EMAIL), notDemoUser));
      if (taken) fail("DEMO_EMAIL_TAKEN", "the operator's account uses the demo e-mail");
      await tx
        .insert(schema.user)
        .values({
          id: DEMO_USER_ID,
          name: "Demo",
          email: DEMO_EMAIL,
          emailVerified: true,
          role: "user",
        })
        .onConflictDoNothing();
      await tx
        .insert(schema.account)
        .values({
          id: DEMO_USER_ID,
          accountId: DEMO_USER_ID,
          providerId: "credential",
          userId: DEMO_USER_ID,
          password: hash,
        })
        .onConflictDoNothing();
    } else {
      // Its sessions and credentials go with it (ON DELETE CASCADE).
      await tx.delete(schema.user).where(eq(schema.user.id, DEMO_USER_ID));
    }
    await recordAudit(tx, actor, {
      action: "system.demo_update",
      targetType: "user",
      targetId: DEMO_USER_ID,
      targetName: DEMO_EMAIL,
      metadata: { from: before, to: input.enabled },
    });
  });
  return { enabled: input.enabled };
}

/** Metadata fields of these actions that list login allow list ranges (the operator's networks). */
const LOGIN_ALLOW_LIST_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "system.login_allow_list_update": ["cidrs", "added", "removed"],
  "account.recover": ["loginAllowListCleared"],
};

/** Ranges as the demo account sees them: cut to /24 or /48 (demoCidr). */
function demoCidrs(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const cut = value.map((v) => (typeof v === "string" ? demoCidr(v) : ""));
  return [...new Set(cut.filter(Boolean))].sort();
}

/**
 * An audit entry as the demo account sees it: client addresses and login allow list ranges
 * reduced to their network, and the e-mail a failed sign-in typed left out.
 */
export function demoAuditEntry(entry: AuditLogEntry): AuditLogEntry {
  const { email: _typed, ...metadata } = entry.metadata;
  for (const field of LOGIN_ALLOW_LIST_FIELDS[entry.action] ?? []) {
    if (field in metadata) metadata[field] = demoCidrs(metadata[field]);
  }
  return {
    ...entry,
    ip: demoAddress(entry.ip),
    targetName: entry.action === "auth.sign_in_failed" ? "" : entry.targetName,
    metadata,
  };
}

/** An access log line as the demo account sees it: addresses reduced, headers left out. */
export function demoLogEntry(entry: LogEntry): LogEntry {
  return {
    ...entry,
    clientIp: demoAddress(entry.clientIp),
    peerIp: demoAddress(entry.peerIp),
    headers: {},
  };
}
