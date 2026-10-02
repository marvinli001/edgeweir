import { ExpressionError, type ExpressionErrorCode } from "@edgeweir/rule-engine";
import type * as z from "zod";

/** What an expression is: a rule condition, a redirect target or rewrite path, a cache rule condition. */
export const expressionKinds = ["condition", "value", "cacheRule"] as const;

/** Why the parser refused an expression: the `params` of its zod issue. */
export interface ExpressionIssueParams {
  expressionError: {
    code: ExpressionErrorCode;
    position: number;
    params: Readonly<Record<string, string>>;
  };
}

/**
 * Adds the issue of an expression the parser refused at `path`: the English message, and its
 * code, position and parameters as the issue's params (clients localize them).
 */
export function addExpressionIssue(
  ctx: z.RefinementCtx,
  error: unknown,
  path: (string | number)[],
): void {
  ctx.addIssue({
    code: "custom",
    message: error instanceof Error ? error.message : "invalid expression",
    path,
    params:
      error instanceof ExpressionError
        ? ({
            expressionError: { code: error.code, position: error.position, params: error.params },
          } satisfies ExpressionIssueParams)
        : undefined,
  });
}

/** The expression error an issue carries, if any. */
export function expressionIssue(
  issue: z.core.$ZodIssue,
): ExpressionIssueParams["expressionError"] | null {
  if (issue.code !== "custom") return null;
  const params = issue.params as Partial<ExpressionIssueParams> | undefined;
  return params?.expressionError ?? null;
}
