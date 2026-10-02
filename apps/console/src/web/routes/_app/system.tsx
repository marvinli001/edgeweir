import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { BanSettingsCard } from "@/components/ban-settings";
import { CopyButton } from "@/components/copy-button";
import { GeoIpSettings } from "@/components/geoip-settings";
import { OriginAllowListCard } from "@/components/origin-allow-list";
import { Page } from "@/components/page";
import { PlatformErrorPagesCard } from "@/components/platform-error-pages";
import { ProtectionSettingsCards } from "@/components/protection-settings";
import { ReleaseSourceCard } from "@/components/release-source";
import { SmtpSettings } from "@/components/smtp-settings";
import { ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { UsageSettingsCard } from "@/components/usage-settings";
import { formatDateTime, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

export const Route = createFileRoute("/_app/system")({
  component: SystemSettingsPage,
});

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr] sm:items-center sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2 text-sm break-all">{children}</dd>
    </div>
  );
}

function SystemSettingsPage() {
  const settings = useQuery(orpc.settings.get.queryOptions());
  return (
    <Page title={m.system_title()}>
      <Card>
        <CardHeader>
          <CardTitle>{m.system_info()}</CardTitle>
        </CardHeader>
        <CardContent>
          {settings.isPending ? (
            <LoadingState />
          ) : settings.isLoadingError ? (
            <ErrorState error={settings.error} onRetry={() => settings.refetch()} />
          ) : (
            <dl className="divide-y">
              <Row label={m.system_version()}>
                <span className="font-mono">{settings.data.version}</span>
              </Row>
              <Row label={m.system_console_url()}>
                <span className="font-mono">{settings.data.consoleUrl}</span>
              </Row>
              <Row label={m.system_node_api_url()}>
                <span className="font-mono">{settings.data.nodeApiUrl}</span>
              </Row>
              <Row label={m.system_ca_fingerprint()}>
                <code className="min-w-0 flex-1 font-mono text-xs" data-testid="ca-fingerprint">
                  {settings.data.nodeCaSha256}
                </code>
                <CopyButton value={settings.data.nodeCaSha256} iconOnly />
              </Row>
              <Row label={m.system_analytics()}>
                <Badge variant="outline">{settings.data.analyticsMode}</Badge>
              </Row>
              <Row label={m.system_telemetry()}>
                <Badge variant="secondary">
                  {settings.data.telemetryEnabled
                    ? m.system_telemetry_on()
                    : m.system_telemetry_off()}
                </Badge>
              </Row>
              <Row label={m.system_setup_token()}>
                <Badge variant="secondary" data-testid="setup-token-state">
                  {settings.data.setupCompletedAt
                    ? m.system_setup_token_used({
                        time: formatDateTime(settings.data.setupCompletedAt),
                      })
                    : m.system_setup_token_pending()}
                </Badge>
              </Row>
              <Row label={m.system_openapi()}>
                <a
                  className="font-mono text-primary underline-offset-4 hover:underline"
                  href="/api/v1/openapi.json"
                >
                  /api/v1/openapi.json
                </a>
              </Row>
            </dl>
          )}
        </CardContent>
      </Card>
      <OriginAllowListCard />
      <ReleaseSourceCard />
      <UsageSettingsCard />
      <BanSettingsCard />
      <ProtectionSettingsCards />
      <PlatformErrorPagesCard />
      <GeoIpSettings />
      <SmtpSettings />
    </Page>
  );
}
