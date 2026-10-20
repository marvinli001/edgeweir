import { alertPolicy } from "@edgeweir/contract";
import { defineSetting } from "./settings";

/** The alert thresholds (system_setting alert_policy). */
export const alertPolicySetting = defineSetting({
  key: "alert_policy",
  schema: alertPolicy,
  defaults: alertPolicy.parse({}),
  auditAction: "alert.policy_update",
});
