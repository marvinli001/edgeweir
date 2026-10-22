import { oc } from "@orpc/contract";
import * as z from "zod";
import { formatCidr, parseCidr, parseIp } from "./addresses";

/**
 * The demo account (settings.demo): a fixed sign-in beside the operator's
 * account that can read everything and change nothing. Switching it off
 * deletes the account and its sessions.
 */
export const DEMO_USER_ID = "demo";
export const DEMO_EMAIL = "demo@edgeweir.com";
export const DEMO_PASSWORD = "demo";

const demoSettings = z.object({ enabled: z.boolean() });
export type DemoSettings = z.infer<typeof demoSettings>;

/**
 * What the demo account sees of a client address: its /24 (IPv4) or /48
 * (IPv6) network, so visitors' and the operator's addresses stay private.
 * Text that is not an address is dropped.
 */
export function demoAddress(text: string): string {
  if (!text) return text;
  const ip = parseIp(text);
  if (!ip) return "";
  const cidr = parseCidr(`${text}/${ip.version === 4 ? 24 : 48}`);
  return cidr ? formatCidr(cidr) : "";
}

export const demoProcedures = {
  demo: oc
    .route({ method: "GET", path: "/settings/demo", tags: ["settings"] })
    .output(demoSettings),
  setDemo: oc
    .route({ method: "PUT", path: "/settings/demo", tags: ["settings"] })
    .input(demoSettings)
    .output(demoSettings),
};
