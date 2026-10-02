import { createFileRoute } from "@tanstack/react-router";
import { BanSettingsCard } from "@/components/ban-settings";
import { GeoIpSettings } from "@/components/geoip-settings";
import { Page } from "@/components/page";
import { ProtectionSettingsCards } from "@/components/protection-settings";
import { m } from "@/lib/i18n";

/** Platform-wide protection: Under Attack, the CC template, ban limits and GeoIP. */
export const Route = createFileRoute("/_app/protection")({ component: ProtectionPage });

function ProtectionPage() {
  return (
    <Page title={m.protection_page_title()}>
      <ProtectionSettingsCards />
      <BanSettingsCard />
      <GeoIpSettings />
    </Page>
  );
}
