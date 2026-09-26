import { createHmac } from "node:crypto";
import { type AlertChannelConfig, alertChannelInput } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createAlertChannel } from "../../src/server/services/alerts";
import { deliverNotification } from "../../src/server/services/notification-delivery";
import { createTestContext } from "./helpers";

const transport = vi.hoisted(() => ({
  calls: [] as { url: string; body: Record<string, unknown> }[],
  reply: { ok: true, errcode: 0 } as Record<string, unknown>,
}));
vi.mock("../../src/server/lib/outbound", () => ({
  postNotification: async (_app: unknown, url: string, body: Record<string, unknown>) => {
    transport.calls.push({ url, body });
    return transport.reply;
  },
  outboundAddress: vi.fn(),
}));
describe("notification provider protocols without external messages", async () => {
  const { ctx, client } = await createTestContext();
  afterAll(() => client.close());
  const send = async (config: AlertChannelConfig) => {
    const created = await createAlertChannel(
      ctx,
      alertChannelInput.parse({ name: "fixture", locale: "en", config }),
      { type: "system", id: "" },
    );
    const [row] = await ctx.db
      .select()
      .from(schema.alertChannel)
      .where(eq(schema.alertChannel.id, created.id));
    if (!row) throw new Error("missing channel");
    return deliverNotification(ctx, row, {
      id: crypto.randomUUID(),
      siteId: null,
      siteName: "fixture",
      kind: "test",
      status: "firing",
      occurredAt: new Date().toISOString(),
    });
  };
  it("signs DingTalk requests with the configured secret and timestamp", async () => {
    await send({
      kind: "dingtalk",
      url: "https://oapi.dingtalk.com/robot/send?access_token=fixture",
      secret: "SEC-fixture",
    });
    const call = transport.calls.at(-1);
    if (!call) throw new Error("no request");
    const url = new URL(call.url),
      timestamp = url.searchParams.get("timestamp");
    expect(timestamp).toMatch(/^\d+$/);
    expect(url.searchParams.get("sign")).toBe(
      createHmac("sha256", "SEC-fixture").update(`${timestamp}\nSEC-fixture`).digest("base64"),
    );
    expect(call.body.msgtype).toBe("text");
  });
  it("sends WeCom text and checks the provider error code", async () => {
    await send({
      kind: "wecom",
      url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture",
    });
    expect(transport.calls.at(-1)?.body.msgtype).toBe("text");
    transport.reply = { errcode: 40001 };
    await expect(
      send({ kind: "wecom", url: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fixture" }),
    ).rejects.toThrow("rejected");
    transport.reply = { ok: true, errcode: 0 };
  });
  it("sends Telegram text without link previews or paid broadcasts", async () => {
    await send({
      kind: "telegram",
      token: "123456:abcdefghijklmnopqrstuvwxyz",
      chatId: "-100123456",
    });
    const call = transport.calls.at(-1);
    expect(call?.url).toBe(
      "https://api.telegram.org/bot123456:abcdefghijklmnopqrstuvwxyz/sendMessage",
    );
    expect(call?.body).toMatchObject({
      chat_id: "-100123456",
      link_preview_options: { is_disabled: true },
    });
    expect(call?.body).not.toHaveProperty("allow_paid_broadcast");
  });
});
