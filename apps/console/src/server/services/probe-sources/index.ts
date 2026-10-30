import type { ProbeSourceProvider } from "@edgeweir/contract";
import { aliyunSiteMonitor } from "./aliyun";
import { betterstack } from "./betterstack";
import { checkly } from "./checkly";
import { datadog } from "./datadog";
import { genericWebhook } from "./generic";
import { pingdom } from "./pingdom";
import { tencentCat } from "./tencent";
import type { ProbeSourceAdapter } from "./types";
import { uptimerobot } from "./uptimerobot";

const ADAPTERS: Record<ProbeSourceProvider, ProbeSourceAdapter> = {
  generic_webhook: genericWebhook,
  uptimerobot,
  betterstack,
  pingdom,
  checkly,
  datadog,
  aliyun_site_monitor: aliyunSiteMonitor,
  tencent_cat: tencentCat,
};

export function adapterOf(provider: string): ProbeSourceAdapter | undefined {
  return (ADAPTERS as Record<string, ProbeSourceAdapter | undefined>)[provider];
}
