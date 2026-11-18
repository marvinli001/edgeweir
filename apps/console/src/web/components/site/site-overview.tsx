import type { AnalyticsRange, Site } from "@edgeweir/contract";
import { Edit02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { FormDialog } from "@/components/form-dialog";
import { Field, FieldLabel } from "@/components/layout/form";
import { Panel, PanelContent, PanelHeader, PanelTitle } from "@/components/layout/panel";
import { WorkspaceOverview } from "@/components/layout/workspace-overview";
import { DnsSetupCard } from "@/components/site/cname-target";
import { DevelopmentModeControl } from "@/components/site/development-mode-card";
import { DomainName } from "@/components/site/domain-name";
import { LaunchCheck } from "@/components/site/launch-check";
import { LiveRequests } from "@/components/site/live-requests";
import { SaveBar, useSaveSite } from "@/components/site/save-site";
import { UnderAttackQuick } from "@/components/site/security-tab";
import { SiteTraffic } from "@/components/site/site-traffic";
import { UsageGuardCard } from "@/components/site/usage-guard-card";
import { SiteStatus } from "@/components/site-status";
import { TagBadges, TagPicker } from "@/components/site-tags";
import { TimeAgo } from "@/components/time-ago";
import { useDraft } from "@/hooks/use-draft";
import { m } from "@/lib/i18n";
import { client, orpc } from "@/lib/orpc";
import { toast } from "@/lib/toast";

export function SiteOverview({
  site,
  range,
  setRange,
  analyticsHref,
}: {
  site: Site;
  range: AnalyticsRange;
  setRange: (range: AnalyticsRange) => void;
  analyticsHref: string;
}) {
  return (
    <WorkspaceOverview
      status={<SiteFacts site={site} />}
      main={
        <>
          {site.enabled ? <LiveRequests siteId={site.id} /> : null}
          <SiteTraffic
            siteId={site.id}
            range={range}
            setRange={setRange}
            analyticsHref={analyticsHref}
          />
          <LaunchCheck site={site} />
          <UsageGuardCard site={site} />
        </>
      }
      aside={
        <>
          <DnsSetupCard siteId={site.id} title={m.scope_connection_method()} />
          <Panel>
            <PanelHeader>
              <PanelTitle>{m.scope_quick_actions()}</PanelTitle>
            </PanelHeader>
            <PanelContent className="flex flex-col gap-3">
              <DevelopmentModeControl siteId={site.id} quick />
              <UnderAttackQuick siteId={site.id} />
            </PanelContent>
          </Panel>
        </>
      }
    />
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-2.5 @xs/facts:grid-cols-[6.5rem_minmax(0,1fr)] @xs/facts:items-center @xs/facts:gap-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-2 text-sm">{children}</dd>
    </div>
  );
}

function SiteFacts({ site }: { site: Site }) {
  // A draft: enabling the site or a refetch keeps a name being edited.
  const { draft: name, setDraft: setName } = useDraft(site.name);
  const { save, error, pending } = useSaveSite(site.id);

  return (
    <Panel className="@container/facts">
      <form
        className="flex flex-col gap-(--panel-pad)"
        onSubmit={(event) => {
          event.preventDefault();
          void save({ name: name.trim() });
        }}
      >
        <PanelHeader>
          <PanelTitle>{m.scope_site_status()}</PanelTitle>
        </PanelHeader>
        <PanelContent>
          <Field className="pb-2">
            <FieldLabel htmlFor="site-name">{m.site_form_name()}</FieldLabel>
            <Input
              id="site-name"
              value={name}
              required
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              data-testid="site-name-input"
            />
          </Field>
          <dl className="divide-y border-t">
            <InfoRow label={m.sites_col_status()}>
              <SiteStatus site={site} />
            </InfoRow>
            <InfoRow label={m.sites_col_domains()}>
              <span className="flex min-w-0 flex-col font-mono text-xs leading-5">
                {site.domains.map((d) => (
                  <DomainName key={d} domain={d} className="break-all" />
                ))}
              </span>
            </InfoRow>
            <InfoRow label={m.sites_col_cluster()}>
              <Badge size="sm" tone="neutral">
                {site.clusterName}
              </Badge>
            </InfoRow>
            <InfoRow label={m.tags_label()}>
              <SiteTagsRow site={site} />
            </InfoRow>
            <InfoRow label={m.site_updated_at()}>
              <TimeAgo at={site.updatedAt} />
            </InfoRow>
          </dl>
        </PanelContent>
        <SaveBar
          dirty={name.trim() !== site.name && name.trim() !== ""}
          pending={pending}
          error={error}
          testId="site-name-save"
        />
      </form>
    </Panel>
  );
}

/** The site's tags, and a dialog that edits them (saved at once: tags are not published). */
function SiteTagsRow({ site }: { site: Site }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(false);
  const [tags, setTags] = React.useState<string[]>([]);
  return (
    <>
      <TagBadges
        tags={site.tags}
        onSelect={(tag) => void navigate({ to: "/sites", search: { tags: [tag.id] } })}
      />
      <Button
        className="icon-button"
        size="sm"
        variant="ghost"
        aria-label={m.tags_label()}
        onClick={() => {
          setTags(site.tags.map((tag) => tag.name));
          setOpen(true);
        }}
        data-testid="site-tags-edit"
      >
        <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} />
      </Button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={m.tags_label()}
        submitLabel={m.common_save()}
        submitTestId="site-tags-save"
        onSubmit={async () => {
          await client.sites.setTags({ id: site.id, tags });
          toast.success(m.tags_saved());
          setOpen(false);
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: orpc.sites.key() }),
            queryClient.invalidateQueries({ queryKey: orpc.siteTags.key() }),
          ]);
        }}
      >
        <TagPicker id="site-tags" value={tags} onChange={setTags} />
      </FormDialog>
    </>
  );
}
