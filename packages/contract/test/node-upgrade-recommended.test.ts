import { describe, expect, it } from "vitest";
import {
  AUTH_IDENTITY_HEADERS_FEATURE,
  CERTIFICATE_ISOLATION_FEATURE,
  nodeUpgradeRecommended,
} from "../src/node-features";

describe("nodeUpgradeRecommended", () => {
  it("recommends an upgrade to nodes without the security fixes no configuration requires", () => {
    expect(nodeUpgradeRecommended(["access-auth-v1", "access-control-v1"])).toBe(true);
    expect(nodeUpgradeRecommended([AUTH_IDENTITY_HEADERS_FEATURE])).toBe(true);
    expect(
      nodeUpgradeRecommended([AUTH_IDENTITY_HEADERS_FEATURE, CERTIFICATE_ISOLATION_FEATURE]),
    ).toBe(false);
  });
});
