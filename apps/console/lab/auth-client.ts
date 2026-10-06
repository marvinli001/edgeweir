/**
 * Lab stand-in for `@/lib/auth-client`: always signed in as the fixture operator; sign-in,
 * second factor and passkey calls succeed at once, so the auth pages can be clicked through.
 */
import type { authClient as RealAuthClient, Session as RealSession } from "@/lib/auth-client";

export type Session = RealSession;

const created = new Date(Date.now() - 210 * 24 * 3_600_000);

const user = {
  id: "lab-operator",
  name: "Operator",
  email: "ops@example.com",
  emailVerified: true,
  image: null,
  createdAt: created,
  updatedAt: created,
  twoFactorEnabled: true,
};

const session = {
  id: "lab-session",
  userId: user.id,
  token: "lab",
  expiresAt: new Date(Date.now() + 7 * 24 * 3_600_000),
  createdAt: new Date(),
  updatedAt: new Date(),
  ipAddress: "192.0.2.10",
  userAgent: "lab",
};

const ok = <T>(data: T) => Promise.resolve({ data, error: null });

const stub = {
  getSession: () => ok({ user, session }),
  signIn: {
    email: () => ok({ redirect: false, token: "lab", user }),
    passkey: () => ok({ session, user }),
  },
  signOut: () => ok({ success: true }),
  changePassword: () => ok({ token: null, user }),
  passkey: {
    addPasskey: () => ok(null),
    deletePasskey: () => ok(null),
    listUserPasskeys: () => ok([]),
  },
  twoFactor: {
    enable: () => ok({ totpURI: "", backupCodes: [] }),
    disable: () => ok({ status: true }),
    verifyTotp: () => ok({ token: "lab", user }),
    verifyBackupCode: () => ok({ token: "lab", user }),
  },
};

export const authClient = stub as unknown as typeof RealAuthClient;
