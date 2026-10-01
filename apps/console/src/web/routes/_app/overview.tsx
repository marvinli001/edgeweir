import { analyticsRange } from "@edgeweir/contract";
import { Add01Icon, GlobeIcon, HistoryIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import * as z from "zod";
import { AnalyticsSection } from "@/components/analytics/analytics-section";
import { Page } from "@/components/page";
import { ResourceEmpty, ResourceList, ResourceRow } from "@/components/resource-list";
import { StarMark, useSiteStars } from "@/components/site-star";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { buttonVariants } from "@/components/ui/button";
import { DEFAULT_RANGE } from "@/lib/analytics";
import { formatNumber, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { RECENT_PAGES, readRecents } from "@/lib/recents";
import { siteTabLabel } from "@/lib/site-tabs";

const LIST_SIZE = 5;

export const Route = createFileRoute("/_app/overview")({
  validateSearch: z.object({ range: analyticsRange.optional() }),
  component: OverviewPage,
});

function OverviewPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const sites = useQuery({
    ...orpc.sites.list.queryOptions({ input: { pageSize: LIST_SIZE } }),
    refetchInterval: 30_000,
    meta: { background: true },
  });
  const { starred } = useSiteStars();

  return (
    <Page title={m.overview_title()}>
      {sites.isPending || starred.isPending ? (
        <LoadingState />
      ) : sites.isError ? (
        <ErrorState error={sites.error} onRetry={() => sites.refetch()} />
      ) : starred.isError ? (
        <ErrorState error={starred.error} onRetry={() => starred.refetch()} />
      ) : sites.data.total === 0 ? (
        <EmptyState icon={GlobeIcon} title={m.sites_empty_title()}>
          <Link to="/sites" search={{ create: true }} className={buttonVariants()}>
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.nav_new_site()}
          </Link>
        </EmptyState>
      ) : (
        <>
          <div className="grid gap-x-10 gap-y-6 @3xl/main:grid-cols-2">
            <SitesList total={sites.data.total} starred={starred.data} recent={sites.data.items} />
            <RecentsList />
          </div>
          <AnalyticsSection
            range={search.range ?? DEFAULT_RANGE}
            onRangeChange={(range) =>
              navigate({ search: { range: range === DEFAULT_RANGE ? undefined : range } })
            }
            topLists={[
              {
                id: "sites",
                title: m.analytics_top_sites(),
                renderLink: (item, props) => (
                  <Link to="/sites/$id" params={{ id: item.id }} {...props} />
                ),
              },
            ]}
            delay={120}
          />
        </>
      )}
    </Page>
  );
}

/** Starred sites first, then the oldest sites, like the zone list of a CDN dashboard. */
function SitesList({
  total,
  starred,
  recent,
}: {
  total: number;
  starred: { id: string; name: string; domains: string[] }[];
  recent: { id: string; name: string; domains: string[] }[];
}) {
  const starredIds = new Set(starred.map((s) => s.id));
  const rows = [
    ...starred.map((s) => ({ ...s, starred: true })),
    ...recent.filter((s) => !starredIds.has(s.id)).map((s) => ({ ...s, starred: false })),
  ].slice(0, LIST_SIZE);
  return (
    <ResourceList
      title={m.nav_sites()}
      count={formatNumber(total)}
      link={{ to: "/sites" }}
      testId="home-sites"
      className="animate-enter"
    >
      {rows.map((site) => (
        <ResourceRow
          key={site.id}
          icon={<HugeiconsIcon icon={GlobeIcon} strokeWidth={2} />}
          link={{ to: "/sites/$id", params: { id: site.id } }}
          trailing={site.starred ? <StarMark /> : null}
          testId="home-site"
        >
          <span className="truncate font-medium">{site.name}</span>
          {site.domains[0] && site.domains[0] !== site.name ? (
            <span className="truncate text-xs text-muted-foreground">{site.domains[0]}</span>
          ) : null}
        </ResourceRow>
      ))}
    </ResourceList>
  );
}

function RecentsList() {
  const { session } = Route.useRouteContext();
  // Read once per visit; this page never records itself.
  const [recents] = React.useState(() => readRecents(session.user.id));
  return (
    <ResourceList
      title={m.home_recents()}
      testId="home-recents"
      className="animate-enter"
      style={{ animationDelay: "60ms" }}
    >
      {recents.length === 0 ? (
        <ResourceEmpty>{m.home_recents_empty()}</ResourceEmpty>
      ) : (
        recents.map((recent) => {
          const [area, title] =
            recent.kind === "page"
              ? RECENT_PAGES[recent.path]()
              : recent.tab
                ? [recent.name, siteTabLabel(recent.tab)]
                : [m.nav_sites(), recent.name];
          return (
            <ResourceRow
              key={recent.kind === "page" ? recent.path : `${recent.id}-${recent.tab ?? ""}`}
              icon={<HugeiconsIcon icon={HistoryIcon} strokeWidth={2} />}
              link={
                recent.kind === "page"
                  ? { to: recent.path }
                  : {
                      to: "/sites/$id",
                      params: { id: recent.id },
                      search: recent.tab ? { tab: recent.tab } : {},
                    }
              }
              testId="home-recent"
            >
              <span className="truncate">
                <span className="text-muted-foreground">{area} / </span>
                <span className="font-medium">{title}</span>
              </span>
            </ResourceRow>
          );
        })
      )}
    </ResourceList>
  );
}
