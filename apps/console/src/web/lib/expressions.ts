import type { ExpressionErrorCode } from "@edgeweir/rule-engine";
// Relative on purpose: the module is unit-tested outside Vite's "@" alias.
import { m } from "../paraglide/messages.js";

type MessageFn = (params?: Record<string, string | number>) => string;
const messages = m as unknown as Record<string, MessageFn | undefined>;

/** An expression the parser refused: its code, source offset and the values its text names. */
export interface ExpressionFailure {
  code: ExpressionErrorCode;
  position: number;
  params: Readonly<Record<string, string>>;
}

/** Why the parser refused an expression, localized (`rules_expr_<code>`). */
export function expressionReason(failure: Pick<ExpressionFailure, "code" | "params">): string {
  const fn = messages[`rules_expr_${failure.code}`];
  return fn ? fn({ ...failure.params }) : failure.code;
}

/** "Character N: reason", N counted from 1. */
export function expressionErrorText(failure: ExpressionFailure): string {
  return m.rules_expression_error({
    position: failure.position + 1,
    reason: expressionReason(failure),
  });
}
