import { createFileRoute } from "@tanstack/react-router";
import { BanSettingsCard } from "@/components/ban-settings";
import { GeoIpSettings } from "@/components/geoip-settings";
import { enterDelay, Page } from "@/components/page";
import { CcTemplateCard, ProtectionSettingsCard } from "@/components/protection-settings";
import { m } from "@/lib/i18n";

/** Platform-wide protection: Under Attack, ban limits, the CC template and GeoIP. */
export const Route = createFileRoute("/_app/protection")({ component: ProtectionPage });

/** The two short cards share a row; the CC template and GeoIP span both columns. */
function ProtectionPage() {
  return (
    <Page title={m.protection_page_title()}>
      <div className="grid gap-6 @4xl/main:grid-cols-2">
        <ProtectionSettingsCard className="animate-enter" style={enterDelay(0, 60)} />
        <BanSettingsCard className="animate-enter" style={enterDelay(1, 60)} />
        <CcTemplateCard className="animate-enter @4xl/main:col-span-2" style={enterDelay(2, 60)} />
        <GeoIpSettings className="animate-enter @4xl/main:col-span-2" style={enterDelay(3, 60)} />
      </div>
    </Page>
  );
}
