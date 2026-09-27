import type { AppContext } from "../lib/context";
import type { Envelope } from "../lib/envelope";

const binding = (nodeId: string) => ({ purpose: "node.revision_receipt", recordId: nodeId });
/** An opaque authenticated receipt, bound to the node, cluster, revision and hash. */
export function mintRevisionReceipt(
  app: AppContext,
  node: { id: string; clusterId: string },
  revision: number,
  hash: string,
) {
  return JSON.stringify(
    app.masterKey.seal(
      JSON.stringify({ clusterId: node.clusterId, revision, hash }),
      binding(node.id),
    ),
  );
}
export function verifyRevisionReceipt(
  app: AppContext,
  node: { id: string; clusterId: string },
  revision: number,
  hash: string,
  token: string,
) {
  if (!token || token.length > 4096) return false;
  try {
    const value = JSON.parse(
      app.masterKey.open(JSON.parse(token) as Envelope, binding(node.id)).toString("utf8"),
    );
    return value.clusterId === node.clusterId && value.revision === revision && value.hash === hash;
  } catch {
    return false;
  }
}
