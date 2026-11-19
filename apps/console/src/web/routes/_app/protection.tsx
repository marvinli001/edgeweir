import { createFileRoute } from "@tanstack/react-router";
import { AiCrawlGlobalCard } from "@/components/ai-crawl-global";
import { BanSettingsCard } from "@/components/ban-settings";
import { ConnectionLimitsCard } from "@/components/connection-limits";
import { GeoIpSettings } from "@/components/geoip-settings";
import { PanelColumns, PanelStack } from "@/components/layout/panel";
import { enterDelay, Page } from "@/components/page";
import {
  CcTemplateCard,
  InteractiveProviderCard,
  ProtectionSettingsCard,
} from "@/components/protection-settings";
import { m } from "@/lib/i18n";

/**
 * Platform-wide protection: Under Attack, ban limits, the interactive provider, the CC template,
 * connection limits, GeoIP and AI crawl control.
 */
export const Route = createFileRoute("/_app/protection")({ component: ProtectionPage });

function ProtectionPage() {
  return (
    <Page title={m.protection_page_title()}>
      <PanelColumns>
        <PanelStack>
          <ProtectionSettingsCard className="animate-enter" style={enterDelay(0, 60)} />
          <InteractiveProviderCard className="animate-enter" style={enterDelay(2, 60)} />
          <CcTemplateCard className="animate-enter" style={enterDelay(4, 60)} />
        </PanelStack>
        <PanelStack>
          <BanSettingsCard className="animate-enter" style={enterDelay(1, 60)} />
          <ConnectionLimitsCard className="animate-enter" style={enterDelay(3, 60)} />
          <GeoIpSettings className="animate-enter" style={enterDelay(5, 60)} />
        </PanelStack>
      </PanelColumns>
      <AiCrawlGlobalCard className="animate-enter" style={enterDelay(6, 60)} />
    </Page>
  );
}
