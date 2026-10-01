import type { Me } from "@edgeweir/contract";

/** `/me` of the operator. */
export function toMe(user: {
  id: string;
  name: string;
  email: string;
  twoFactorEnabled?: boolean | null;
}): Me {
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      twoFactorEnabled: user.twoFactorEnabled === true,
    },
    serviceAccount: null,
  };
}

/** `/me` of a service account: its identity and scopes. */
export function serviceAccountMe(account: { id: string; name: string; scopes: string[] }): Me {
  return {
    user: { id: account.id, name: account.name, email: "", twoFactorEnabled: false },
    serviceAccount: { id: account.id, name: account.name, scopes: account.scopes },
  };
}
