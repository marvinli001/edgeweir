import type { HttpsBlocker } from "@edgeweir/contract";
// Relative on purpose: the module is unit-tested outside Vite's "@" alias.
import { m } from "../paraglide/messages.js";
import { getLocale } from "../paraglide/runtime.js";
import { localizeError } from "./errors";

/** The first five items, "+N" for the rest. */
function shortList(items: readonly string[]) {
  const shown = items.slice(0, 5).join(getLocale() === "zh-CN" ? "、" : ", ");
  return items.length > 5 ? `${shown} +${items.length - 5}` : shown;
}

/** What stops one-click HTTPS (https.check), as one short line. `ca`: the CA's name. */
export function httpsBlockerText(blocker: HttpsBlocker, ca: string): string {
  switch (blocker.code) {
    case "nodes_offline":
      return m.https_blocker_nodes_offline({ cluster: blocker.cluster });
    case "nodes_lack_http01":
      return m.https_blocker_nodes_lack_http01({ nodes: shortList(blocker.nodes) });
    case "dns_not_pointing":
      return blocker.pointing === "unresolved"
        ? m.https_blocker_dns_unresolved({ name: blocker.name })
        : m.https_blocker_dns_elsewhere({ name: blocker.name });
    case "dns_credential_missing":
      return m.https_blocker_dns_credential_missing({ names: shortList(blocker.names) });
    case "dns_credential_failed":
      return m.https_blocker_dns_credential_failed({
        credential: blocker.credential,
        error: localizeError({ code: blocker.error }),
      });
    case "caa_forbidden":
      return m.https_blocker_caa_forbidden({ name: blocker.name, ca });
  }
}
