import { describe, expect, it } from "vitest";
import { alertChannelConfig, releaseBaseUrl } from "../src/index";

describe("URL fields", () => {
  it("reject a value that is not a URL instead of throwing", () => {
    expect(releaseBaseUrl.safeParse("abc").success).toBe(false);
    for (const kind of ["webhook", "dingtalk", "wecom"])
      expect(alertChannelConfig.safeParse({ kind, url: "abc" }).success).toBe(false);
  });

  it("accept the URLs they are for", () => {
    expect(releaseBaseUrl.safeParse("https://mirror.example/releases").success).toBe(true);
    expect(
      alertChannelConfig.safeParse({ kind: "webhook", url: "https://hooks.example/a" }).success,
    ).toBe(true);
    expect(
      alertChannelConfig.safeParse({
        kind: "dingtalk",
        url: "https://oapi.dingtalk.com/robot/send?access_token=x",
      }).success,
    ).toBe(true);
    expect(
      alertChannelConfig.safeParse({ kind: "dingtalk", url: "https://hooks.example/a" }).success,
    ).toBe(false);
  });
});
