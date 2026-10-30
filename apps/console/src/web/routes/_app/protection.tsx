import { createFileRoute } from "@tanstack/react-router";
import { AiCrawlGlobalCard } from "@/components/ai-crawl-global";
import { BanSettingsCard } from "@/components/ban-settings";
import { ConnectionLimitsCard } from "@/components/connection-limits";
import { GeoIpSettings } from "@/components/geoip-settings";
import { enterDelay, Page } from "@/components/page";
import { CcTemplateCard, ProtectionSettingsCard } from "@/components/protection-settings";
import { m } from "@/lib/i18n";

/**
 * Platform-wide protection: Under Attack, ban limits, the CC template, connection limits, GeoIP and
 * AI crawl control.
 */
export const Route = createFileRoute("/_app/protection")({ component: ProtectionPage });

/** The two short cards share a row; the others span both columns. */
function ProtectionPage() {
  return (
    <Page title={m.protection_page_title()}>
      <div className="grid gap-6 @4xl/main:grid-cols-2">
        <ProtectionSettingsCard className="animate-enter" style={enterDelay(0, 60)} />
        <BanSettingsCard className="animate-enter" style={enterDelay(1, 60)} />
        <CcTemplateCard className="animate-enter @4xl/main:col-span-2" style={enterDelay(2, 60)} />
        <ConnectionLimitsCard
          className="animate-enter @4xl/main:col-span-2"
          style={enterDelay(3, 60)}
        />
        <GeoIpSettings className="animate-enter @4xl/main:col-span-2" style={enterDelay(4, 60)} />
        <AiCrawlGlobalCard
          className="animate-enter @4xl/main:col-span-2"
          style={enterDelay(5, 60)}
        />
      </div>
    </Page>
  );
}
