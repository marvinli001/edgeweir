import { auditActionMessageKey, auditTargetMessageKey } from "@edgeweir/contract";
// Relative on purpose: the module is unit-tested outside Vite's "@" alias.
import { m } from "../paraglide/messages.js";

const messages = m as unknown as Record<string, (() => string) | undefined>;

/** Label of an audit action; codes without one (older entries) stay as they are. */
export function auditActionLabel(action: string): string {
  return messages[auditActionMessageKey(action)]?.() ?? action;
}

/** Label of an audit target type; unknown types stay as they are. */
export function auditTargetLabel(type: string): string {
  return messages[auditTargetMessageKey(type)]?.() ?? type;
}
