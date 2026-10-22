import type { AddressResolver } from "../../src/server/lib/dns-check";

/** A resolver that answers from `table`: addresses, NODATA, NXDOMAIN or a timeout. */
export function fakeResolver(table: Record<string, { v4?: string[]; v6?: string[] } | "timeout">) {
  const lookup = (family: "v4" | "v6") => async (name: string) => {
    const entry = table[name];
    if (entry === "timeout") throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
    const answer = entry?.[family];
    if (!answer?.length)
      throw Object.assign(new Error("no data"), { code: entry ? "ENODATA" : "ENOTFOUND" });
    return answer;
  };
  return { resolve4: lookup("v4"), resolve6: lookup("v6") } satisfies AddressResolver;
}
