import type { Me } from "@edgeweir/contract";

/** `/me` of the operator or the demo account. */
export function toMe(
  user: {
    id: string;
    name: string;
    email: string;
    twoFactorEnabled?: boolean | null;
  },
  demo = false,
): Me {
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      twoFactorEnabled: user.twoFactorEnabled === true,
    },
    serviceAccount: null,
    demo,
  };
}

/** `/me` of a service account: its identity and scopes. */
export function serviceAccountMe(account: { id: string; name: string; scopes: string[] }): Me {
  return {
    user: { id: account.id, name: account.name, email: "", twoFactorEnabled: false },
    serviceAccount: { id: account.id, name: account.name, scopes: account.scopes },
    demo: false,
  };
}
