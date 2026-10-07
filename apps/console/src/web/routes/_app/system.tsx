import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import * as z from "zod";
import { CopyButton } from "@/components/copy-button";
import { NodeChannelCard } from "@/components/node-channel";
import { UrlScopeBadge } from "@/components/node-enrollment";
import { OriginAllowListCard } from "@/components/origin-allow-list";
import { Page } from "@/components/page";
import { PlatformErrorPagesCard } from "@/components/platform-error-pages";
import { ProbesPanel } from "@/components/probes";
import { ReleaseSourceCard } from "@/components/release-source";
import { ServiceAccountsPanel } from "@/components/service-accounts";
import { QueryView } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UsageSettingsCard } from "@/components/usage-settings";
import { formatDateTime, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

export const Route = createFileRoute("/_app/system")({
  validateSearch: z.object({
    tab: z.enum(["probes", "service-accounts"]).optional(),
    addProbe: z.boolean().optional(),
  }),
  component: SystemSettingsPage,
});

type Tab = "general" | "probes" | "service-accounts";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-12 gap-1 py-2.5 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center sm:gap-4">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-2 text-sm break-all">{children}</dd>
    </div>
  );
}

/** System settings: general settings, monitoring (probes) and service accounts. */
function SystemSettingsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const tab: Tab = search.tab ?? "general";
  const [createAccount, setCreateAccount] = React.useState(false);
  const setAddProbe = (open: boolean) =>
    navigate({ search: (prev) => ({ ...prev, addProbe: open || undefined }), replace: true });
  return (
    <Page
      title={m.system_title()}
      actions={
        tab === "probes" ? (
          <Button size="sm" onClick={() => setAddProbe(true)} data-testid="add-probe">
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.probes_add()}
          </Button>
        ) : tab === "service-accounts" ? (
          <Button
            size="sm"
            onClick={() => setCreateAccount(true)}
            data-testid="service-account-new"
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.service_accounts_create()}
          </Button>
        ) : null
      }
    >
      <Tabs
        value={tab}
        onValueChange={(value) =>
          navigate({
            search: {
              tab: value === "probes" || value === "service-accounts" ? value : undefined,
            },
            replace: true,
          })
        }
      >
        {/* The page's tab bar: line tabs over a hairline, scrolling sideways on phones. */}
        <TabsList
          variant="line"
          className="h-11 w-full max-w-full justify-start gap-0.5 overflow-x-auto overflow-y-hidden border-b px-0 pt-1 pb-[5px] [scrollbar-width:none]"
        >
          <TabsTrigger
            value="general"
            className="flex-none px-2.5"
            data-testid="system-tab-general"
          >
            {m.system_tab_general()}
          </TabsTrigger>
          <TabsTrigger value="probes" className="flex-none px-2.5" data-testid="system-tab-probes">
            {m.system_tab_probes()}
          </TabsTrigger>
          <TabsTrigger
            value="service-accounts"
            className="flex-none px-2.5"
            data-testid="system-tab-service-accounts"
          >
            {m.nav_service_accounts()}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="general" className="flex flex-col gap-6 pt-4 animate-enter">
          <GeneralSettings />
        </TabsContent>
        <TabsContent value="probes" className="pt-4 animate-enter">
          <ProbesPanel addOpen={search.addProbe === true} onAddOpenChange={setAddProbe} />
        </TabsContent>
        <TabsContent value="service-accounts" className="pt-4 animate-enter">
          <ServiceAccountsPanel createOpen={createAccount} onCreateOpenChange={setCreateAccount} />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

function GeneralSettings() {
  const settings = useQuery(orpc.settings.get.queryOptions());
  return (
    <>
      <Card className="animate-enter">
        <CardHeader>
          <CardTitle>{m.system_info()}</CardTitle>
        </CardHeader>
        <CardContent>
          <QueryView query={settings}>
            {(system) => (
              <dl className="divide-y">
                <Row label={m.system_version()}>
                  <span className="font-mono text-[13px]">{system.version}</span>
                </Row>
                <Row label={m.system_console_url()}>
                  <span className="font-mono text-[13px]">{system.consoleUrl}</span>
                  <UrlScopeBadge url={system.consoleUrl} testId="console-url-scope" />
                </Row>
                <Row label={m.system_ca_fingerprint()}>
                  <code
                    className="min-w-0 flex-1 rounded-xl px-2.5 py-1.5 font-mono text-xs leading-relaxed sunk-well"
                    data-testid="ca-fingerprint"
                  >
                    {system.nodeCaSha256}
                  </code>
                  <CopyButton value={system.nodeCaSha256} iconOnly />
                </Row>
                <Row label={m.system_analytics()}>
                  <Badge variant="secondary" className="font-mono">
                    {system.analyticsMode}
                  </Badge>
                </Row>
                <Row label={m.system_setup_token()}>
                  <Badge variant="secondary" data-testid="setup-token-state">
                    {system.setupCompletedAt
                      ? m.system_setup_token_used({
                          time: formatDateTime(system.setupCompletedAt),
                        })
                      : m.system_setup_token_pending()}
                  </Badge>
                </Row>
                <Row label={m.system_openapi()}>
                  <a
                    className="rounded-sm font-mono text-[13px] text-primary-ink underline-offset-4 outline-none focus-lit hover:underline"
                    href="/api/v1/openapi.json"
                  >
                    /api/v1/openapi.json
                  </a>
                </Row>
              </dl>
            )}
          </QueryView>
        </CardContent>
      </Card>
      <NodeChannelCard />
      <OriginAllowListCard />
      <ReleaseSourceCard />
      <UsageSettingsCard />
      <PlatformErrorPagesCard />
    </>
  );
}
