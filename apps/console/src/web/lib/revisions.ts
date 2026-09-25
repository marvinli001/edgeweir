import type { Revision } from "@edgeweir/contract";
import { m } from "@/paraglide/messages.js";

type MessageFn = (params?: Record<string, string | number>) => string;
const messages = m as unknown as Record<string, MessageFn | undefined>;

/** Why a revision was published, in the current locale (older revisions keep their text). */
export function revisionReason(revision: Pick<Revision, "reason" | "reasonCode" | "reasonParams">) {
  const fn = revision.reasonCode ? messages[`revision_reason_${revision.reasonCode}`] : undefined;
  return fn ? fn(revision.reasonParams) : revision.reason;
}
