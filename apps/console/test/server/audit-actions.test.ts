import type { AuditAction, AuditTargetType } from "@edgeweir/contract";
import { describe, expectTypeOf, it } from "vitest";
import type { recordAudit } from "../../src/server/services/audit";

describe("recordAudit", () => {
  it("takes only the actions and target types listed in the contract (labelled in the UI)", () => {
    type Entry = Parameters<typeof recordAudit>[2];
    expectTypeOf<Entry["action"]>().toEqualTypeOf<AuditAction>();
    expectTypeOf<NonNullable<Entry["targetType"]>>().toEqualTypeOf<AuditTargetType | "">();
  });
});
