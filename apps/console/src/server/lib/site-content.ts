import { contentSettings, siteMaintenanceInput } from "@edgeweir/contract";
import type { schema } from "@edgeweir/db";

type SiteRow = typeof schema.site.$inferSelect;

/** The content settings of a site row (charset off when unset or invalid). */
export function readContentSettings(
  row: Pick<SiteRow, "charset" | "requestBodyLimit" | "rulesBodyLimit">,
) {
  const charset = contentSettings.shape.charset.safeParse(row.charset);
  return {
    charset: charset.success
      ? charset.data
      : { name: "off" as const, force: false, uppercase: false },
    requestBodyLimit: row.requestBodyLimit,
    rulesBodyLimit: row.rulesBodyLimit,
  };
}

const storedMaintenance = siteMaintenanceInput.omit({ id: true, expectedUpdatedAt: true });

/** The maintenance settings of a site row (`{}`: off, the defaults). */
export function readMaintenance(value: unknown) {
  const parsed = storedMaintenance.safeParse({ enabled: false, ...(value as object) });
  return parsed.success ? parsed.data : storedMaintenance.parse({ enabled: false });
}
