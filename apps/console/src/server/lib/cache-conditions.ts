import { cacheRuleExpression } from "@edgeweir/contract";
import {
  type Expression,
  listReferences,
  parseExpression,
  type StructuredCacheCondition,
  structuredCacheCondition,
} from "@edgeweir/rule-engine";

/**
 * Longest stored cache rule condition. Input expressions are at most 16384
 * characters, but the builder's expression of long structured lists (and so
 * the migrated rules) can be longer; they stay valid.
 */
export const STORED_CACHE_EXPRESSION_MAX = 131_072;

/** Parses a stored (or contract-validated) cache rule condition; throws ExpressionError. */
export function parseCacheCondition(source: string): Expression {
  return parseExpression(source, "cache", { maxLength: STORED_CACHE_EXPRESSION_MAX });
}

/** The condition of a stored cache rule row (rows from before G5 have only the lists). */
export function storedCacheExpression(row: {
  expression: string;
  pathPrefixes: string[];
  paths: string[];
  extensions: string[];
}): string {
  return cacheRuleExpression(row);
}

/** The builder's form of a condition when it has one, else null (also for invalid ones). */
export function structuredForm(source: string): StructuredCacheCondition | null {
  try {
    return structuredCacheCondition(parseCacheCondition(source));
  } catch {
    return null;
  }
}

/** Names of the IP lists a condition references (`$name`). */
export function cacheConditionLists(source: string): string[] {
  return listReferences(parseCacheCondition(source));
}
