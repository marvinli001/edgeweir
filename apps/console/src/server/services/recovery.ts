import { randomUUID } from "node:crypto";
import { type Database, schema } from "@edgeweir/db";
import { and, eq, inArray, like, or } from "drizzle-orm";
import type { Auth } from "../lib/auth";
import { type Actor, recordAudit } from "./audit";
import type { Executor } from "./revisions";

/**
 * Account recovery from the server (`dist/server/recover.js`): sets a new
 * password and/or turns two-factor authentication off for the only account
 * when the operator can no longer sign in. Nothing here is reachable over
 * HTTP; whoever runs it already has the console's environment and database.
 */

/** The actor of recovery audit entries: a shell on the server, not a session. */
const recoveryActor: Actor = { type: "system", id: "", name: "recover" };

/** A recovery that cannot proceed; the message is safe to print. */
export class RecoveryError extends Error {}

export interface Operator {
  id: string;
  name: string;
  email: string;
  twoFactorEnabled: boolean;
}

/** The console's only account. */
export async function findOperator(db: Executor, opts: { lock?: boolean } = {}): Promise<Operator> {
  const query = db
    .select({
      id: schema.user.id,
      name: schema.user.name,
      email: schema.user.email,
      twoFactorEnabled: schema.user.twoFactorEnabled,
    })
    .from(schema.user)
    .limit(2);
  const users = await (opts.lock ? query.for("update") : query);
  const [user] = users;
  if (!user) {
    throw new RecoveryError("the console has no account yet: create it in the setup wizard");
  }
  if (users.length > 1) {
    // Migration 0034 keeps one account; the console applies it when it starts.
    throw new RecoveryError("the database has more than one account: start the console once first");
  }
  return { ...user, twoFactorEnabled: user.twoFactorEnabled === true };
}

/** better-auth's password length policy (`emailAndPassword`), checked before hashing. */
export async function checkNewPassword(auth: Auth, password: string): Promise<void> {
  const { minPasswordLength, maxPasswordLength } = (await auth.$context).password.config;
  if (password.length < minPasswordLength || password.length > maxPasswordLength) {
    throw new RecoveryError(
      `the password must be ${minPasswordLength}–${maxPasswordLength} characters long`,
    );
  }
}

export interface RecoveryInput {
  /** The new password; unset keeps the current one. */
  password?: string;
  /** Turns two-factor authentication off and deletes the TOTP secret and backup codes. */
  disableTwoFactor?: boolean;
}

export interface RecoveryResult {
  user: Pick<Operator, "id" | "name" | "email">;
  passwordReset: boolean;
  /** Two-factor authentication was on and is now off. */
  twoFactorDisabled: boolean;
  /** Sessions signed out. */
  sessionsRevoked: number;
}

/**
 * Applies the recovery in one transaction with its audit entry (`account.recover`):
 *
 * - the new password is hashed by better-auth (`password.hash` of its context)
 *   and stored on the credential account, as `auth.api.setUserPassword` does;
 * - turning two-factor off clears `user.two_factor_enabled` and deletes the
 *   `two_factor` row, as `/two-factor/disable` does;
 * - every session of the account is deleted, and so are the verification rows
 *   that stand in for one: trusted devices (`trust-device-*`, which skip the
 *   second factor) and pending second-factor steps (`2fa-*` with their
 *   `2fa-attempts-*` counters), which would finish a sign-in started earlier.
 *
 * The entry records what changed, never the password or its hash.
 */
export async function recoverAccount(
  ctx: { db: Database; auth: Auth },
  input: RecoveryInput,
): Promise<RecoveryResult> {
  const { password } = input;
  const disableTwoFactor = input.disableTwoFactor === true;
  if (password === undefined && !disableTwoFactor) {
    throw new RecoveryError("nothing to recover: reset the password or turn two-factor off");
  }
  const authContext = await ctx.auth.$context;
  let hash: string | undefined;
  if (password !== undefined) {
    await checkNewPassword(ctx.auth, password);
    hash = await authContext.password.hash(password);
  }

  return ctx.db.transaction(async (tx) => {
    const operator = await findOperator(tx, { lock: true });
    const userId = operator.id;

    if (hash !== undefined) {
      const credential = and(
        eq(schema.account.userId, userId),
        eq(schema.account.providerId, "credential"),
        eq(schema.account.accountId, userId),
      );
      const updated = await tx
        .update(schema.account)
        .set({ password: hash })
        .where(credential)
        .returning({ id: schema.account.id });
      if (updated.length === 0) {
        await tx.insert(schema.account).values({
          id: authContext.generateId({ model: "account" }) || randomUUID(),
          accountId: userId,
          providerId: "credential",
          userId,
          password: hash,
        });
      }
    }

    if (disableTwoFactor) {
      await tx.delete(schema.twoFactor).where(eq(schema.twoFactor.userId, userId));
      await tx
        .update(schema.user)
        .set({ twoFactorEnabled: false })
        .where(eq(schema.user.id, userId));
    }

    const v = schema.verification;
    const pending = await tx
      .delete(v)
      .where(
        and(
          eq(v.value, userId),
          or(like(v.identifier, "trust-device-%"), like(v.identifier, "2fa-%")),
        ),
      )
      .returning({ identifier: v.identifier });
    const attempts = pending
      .filter((row) => row.identifier.startsWith("2fa-"))
      .map((row) => `2fa-attempts-${row.identifier}`);
    if (attempts.length > 0) await tx.delete(v).where(inArray(v.identifier, attempts));

    const sessions = await tx
      .delete(schema.session)
      .where(eq(schema.session.userId, userId))
      .returning({ id: schema.session.id });

    const result: RecoveryResult = {
      user: { id: userId, name: operator.name, email: operator.email },
      passwordReset: hash !== undefined,
      twoFactorDisabled: disableTwoFactor && operator.twoFactorEnabled,
      sessionsRevoked: sessions.length,
    };
    await recordAudit(tx, recoveryActor, {
      action: "account.recover",
      targetType: "user",
      targetId: userId,
      targetName: operator.name,
      metadata: {
        passwordReset: result.passwordReset,
        twoFactorDisabled: result.twoFactorDisabled,
        sessionsRevoked: result.sessionsRevoked,
      },
    });
    return result;
  });
}
