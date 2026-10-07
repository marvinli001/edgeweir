/**
 * Lab stand-in for `@/lib/auth-client`: always signed in as the fixture operator; sign-in,
 * second factor and passkey calls succeed at once, so the auth pages can be clicked through; the
 * operator has two passkeys.
 */
import type { authClient as RealAuthClient, Session as RealSession } from "@/lib/auth-client";
import { labState } from "./state";

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

const DAY = 24 * 3_600_000;

/** The operator's passkeys, in better-auth's shape (`Passkey` of @better-auth/passkey). */
const passkeys = [
  {
    id: "lab-passkey-1",
    name: "MacBook Pro",
    publicKey: "",
    userId: user.id,
    credentialID: "lab-credential-1",
    counter: 0,
    deviceType: "multiDevice",
    backedUp: true,
    transports: "internal,hybrid",
    createdAt: new Date(Date.now() - 180 * DAY),
  },
  {
    id: "lab-passkey-2",
    name: "Security key",
    publicKey: "",
    userId: user.id,
    credentialID: "lab-credential-2",
    counter: 41,
    deviceType: "singleDevice",
    backedUp: false,
    transports: "usb,nfc",
    createdAt: new Date(Date.now() - 29 * DAY),
  },
];

/** Passkeys are not an oRPC call: they follow the lab state here (state.ts). */
function listPasskeys() {
  switch (labState()) {
    case "empty":
      return ok([]);
    case "error":
      return Promise.resolve({
        data: null,
        error: { status: 500, message: "Lab: server error" },
      });
    case "loading":
      return new Promise<never>(() => {});
    default:
      return ok(passkeys);
  }
}

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
    listUserPasskeys: listPasskeys,
  },
  twoFactor: {
    enable: () => ok({ totpURI: "", backupCodes: [] }),
    disable: () => ok({ status: true }),
    verifyTotp: () => ok({ token: "lab", user }),
    verifyBackupCode: () => ok({ token: "lab", user }),
  },
};

export const authClient = stub as unknown as typeof RealAuthClient;
