import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as z from "zod";
import type { Actor } from "../../src/server/services/audit";
import { defineSetting } from "../../src/server/services/settings";
import { createTestDatabase } from "./helpers";

describe("defineSetting", async () => {
  const { client, db } = await createTestDatabase();
  const actor: Actor = { type: "user", id: "u1", name: "Operator", ip: "127.0.0.1" };
  const setting = defineSetting({
    key: "test_setting",
    schema: z.object({ limit: z.number().int().min(1), label: z.string() }),
    defaults: { limit: 10, label: "" },
    auditAction: "system.usage_update",
  });
  const stored = async () =>
    (
      await db
        .select()
        .from(schema.systemSetting)
        .where(eq(schema.systemSetting.key, "test_setting"))
    )[0]?.value;
  const audits = () =>
    db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, "test_setting"));

  beforeEach(async () => {
    await db.delete(schema.systemSetting).where(eq(schema.systemSetting.key, "test_setting"));
    await db.delete(schema.auditLog);
  });
  afterAll(() => client.close());

  it("reads the defaults, a saved value over them, and the defaults again when it is invalid", async () => {
    expect(await setting.read(db)).toEqual({ limit: 10, label: "" });
    await db.insert(schema.systemSetting).values({ key: "test_setting", value: { limit: 3 } });
    expect(await setting.read(db)).toEqual({ limit: 3, label: "" });
    await db
      .update(schema.systemSetting)
      .set({ value: { limit: 0, label: "x" } })
      .where(eq(schema.systemSetting.key, "test_setting"));
    expect(await setting.read(db)).toEqual({ limit: 10, label: "" });
  });

  it("stores the value and audits it from → to in the same transaction", async () => {
    const saved = await db.transaction((tx) =>
      setting.write(tx, actor, { limit: 5, label: "five" }),
    );
    expect(saved).toEqual({ limit: 5, label: "five" });
    expect(await stored()).toEqual({ limit: 5, label: "five" });
    const [entry, ...rest] = await audits();
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      action: "system.usage_update",
      actorType: "user",
      actorId: "u1",
      actorName: "Operator",
      targetType: "system_setting",
      targetId: "test_setting",
      targetName: "",
      metadata: { from: { limit: 10, label: "" }, to: { limit: 5, label: "five" } },
    });

    await db.transaction((tx) => setting.write(tx, actor, { limit: 6, label: "six" }));
    expect((await audits()).map((a) => a.metadata)).toContainEqual({
      from: { limit: 5, label: "five" },
      to: { limit: 6, label: "six" },
    });
  });

  it("refuses a value its schema refuses and stores nothing", async () => {
    await expect(
      db.transaction((tx) => setting.write(tx, actor, { limit: 0, label: "zero" })),
    ).rejects.toThrow();
    expect(await stored()).toBeUndefined();
    expect(await audits()).toEqual([]);
  });

  it("removes the saved value for null: the defaults apply again", async () => {
    await db.transaction((tx) => setting.write(tx, actor, { limit: 5, label: "five" }));
    const after = await db.transaction((tx) => setting.write(tx, actor, null));
    expect(after).toEqual({ limit: 10, label: "" });
    expect(await stored()).toBeUndefined();
    expect(await setting.read(db)).toEqual({ limit: 10, label: "" });
    expect((await audits()).map((a) => a.metadata)).toContainEqual({
      from: { limit: 5, label: "five" },
      to: { limit: 10, label: "" },
    });
  });

  it("runs afterWrite on the stored value before the audit entry and adds what it returns", async () => {
    const named = defineSetting({
      key: "test_setting",
      schema: z.object({ limit: z.number(), label: z.string() }),
      defaults: { limit: 10, label: "" },
      auditAction: "system.error_pages_update",
      targetName: "test_setting",
    });
    const seen: unknown[] = [];
    await db.transaction((tx) =>
      named.write(
        tx,
        actor,
        { limit: 7, label: "seven" },
        {
          // A caller that read the value under its own lock passes it on.
          before: { limit: 1, label: "one" },
          afterWrite: async (before) => {
            seen.push(
              before,
              await named.read(tx),
              (await tx.select().from(schema.auditLog)).length,
            );
            return { revisions: { default: 2 } };
          },
          metadata: (before) => ({ changed: before.limit !== 7 }),
        },
      ),
    );
    expect(seen).toEqual([{ limit: 1, label: "one" }, { limit: 7, label: "seven" }, 0]);
    const [entry] = await audits();
    expect(entry).toMatchObject({
      action: "system.error_pages_update",
      targetName: "test_setting",
      metadata: { changed: true, revisions: { default: 2 } },
    });
  });

  it("keeps the old value when afterWrite fails", async () => {
    await db.transaction((tx) => setting.write(tx, actor, { limit: 5, label: "five" }));
    await expect(
      db.transaction((tx) =>
        setting.write(
          tx,
          actor,
          { limit: 6, label: "six" },
          {
            afterWrite: async () => {
              throw new Error("publish failed");
            },
          },
        ),
      ),
    ).rejects.toThrow("publish failed");
    expect(await stored()).toEqual({ limit: 5, label: "five" });
    expect(await audits()).toHaveLength(1);
  });
});
