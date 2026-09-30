import type { OrgLimitResource } from "@edgeweir/contract";
import { m } from "@/paraglide/messages.js";

const LABELS: Record<OrgLimitResource, () => string> = {
  sites: () => m.org_limit_resource_sites(),
  domains: () => m.org_limit_resource_domains(),
  certificates: () => m.org_limit_resource_certificates(),
  ipListEntries: () => m.org_limit_resource_ip_list_entries(),
  purgeTasksPerMinute: () => m.org_limit_resource_purge_tasks_per_minute(),
  purgeUrlsPerHour: () => m.org_limit_resource_purge_urls_per_hour(),
  members: () => m.org_limit_resource_members(),
  bans: () => m.org_limit_resource_bans(),
};

export const ORG_LIMIT_RESOURCES = Object.keys(LABELS) as OrgLimitResource[];

/** Localized name of a limited resource (also used for ORG_LIMIT_EXCEEDED). */
export function orgLimitLabel(resource: string): string {
  return Object.hasOwn(LABELS, resource) ? LABELS[resource as OrgLimitResource]() : resource;
}
