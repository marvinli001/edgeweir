import type { L4App } from "@edgeweir/contract";
import { ArrowDataTransferHorizontalIcon, MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useLocation, useMatch } from "@tanstack/react-router";
import * as React from "react";
import * as z from "zod";
import { Button } from "@/components/arc/button/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/arc/dropdown-menu/dropdown-menu";
import { DeleteL4AppDialog, L4EnabledSwitch } from "@/components/l4/app-actions";
import { L4AppSettings } from "@/components/l4/app-dialog";
import { L4AppOverview } from "@/components/l4/app-overview";
import { L4AppStats } from "@/components/l4/app-stats";
import { L4WorkspaceContext } from "@/components/l4/app-workspace-context";
import { LinkButton } from "@/components/link-button";
import { Page } from "@/components/page";
import {
  type ScopeOption,
  ScopeSwitcher,
  useSwitcherSearch,
} from "@/components/shell/scope-switcher";
import {
  flatScopeItems,
  useSidebarScope,
  useWorkspaceTitle,
} from "@/components/shell/sidebar-scope";
import { QueryView } from "@/components/states";
import { NotFoundPage } from "@/components/status-page";
import { m } from "@/lib/i18n";
import { L4_STATS_RANGES, type L4StatsRange, portsLabel } from "@/lib/l4";
import { L4_VIEWS, type L4View, l4Href } from "@/lib/l4-views";
import { orpc } from "@/lib/orpc";
import { workspaceLink } from "@/lib/workspace-link";
import { listReturnTo } from "@/lib/workspace-nav";

const DEFAULT_RANGE: L4StatsRange = "24h";

export const Route = createFileRoute("/_app/l4/$id")({
  validateSearch: z.object({
    returnTo: z.string().optional(),
    range: z.enum(L4_STATS_RANGES).optional(),
  }),
  component: L4AppPage,
});

function L4AppPage() {
  const { id } = Route.useParams();
  const href = useLocation({ select: (location) => location.href });
  const selected = useMatch({
    from: "/_app/l4/$id/$view",
    shouldThrow: false,
    select: (match) => match.params.view,
  });
  const view: L4View = selected === "stats" || selected === "settings" ? selected : "overview";
  const label = L4_VIEWS[view].label();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const query = useQuery(orpc.l4Apps.get.queryOptions({ input: { id } }));
  const app = query.data;
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const returnTo = listReturnTo("/l4", search.returnTo);
  const back = { href: returnTo, label: m.l4_title() };
  const viewHref = (next: L4View, appId = id, range = search.range) =>
    l4Href(appId, next, { range, returnTo: returnTo === "/l4" ? undefined : returnTo });
  const setRange = (range: L4StatsRange) =>
    void navigate({
      ...workspaceLink(
        l4Href(id, view, { ...search, range: range === DEFAULT_RANGE ? undefined : range }),
      ),
      replace: true,
    });
  useSidebarScope({
    kind: "l4",
    back,
    switcher: (rail) => (
      <L4Switcher app={app} rail={rail} href={(appId) => viewHref(view, appId)} back={back} />
    ),
    items: flatScopeItems(L4_VIEWS, view, viewHref),
    commandGroup: app ? m.scope_current_l4({ name: app.name }) : m.l4_title(),
  });
  useWorkspaceTitle(label, app?.name);
  return (
    <Page
      title={view === "overview" ? (app?.name ?? label) : label}
      actions={
        app ? (
          <>
            {view !== "settings" ? (
              <LinkButton
                {...workspaceLink(viewHref("settings"))}
                size="sm"
                variant="secondary"
                data-testid="l4-app-edit-open"
              >
                {m.common_edit()}
              </LinkButton>
            ) : null}
            <L4EnabledSwitch app={app} button />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    size="sm"
                    variant="ghost"
                    className="icon-button"
                    aria-label={m.common_actions()}
                    data-testid="l4-detail-actions"
                  />
                }
              >
                <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setDeleteOpen(true)}
                  data-testid="l4-app-delete-open"
                >
                  {m.common_delete()}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DeleteL4AppDialog
              app={app}
              open={deleteOpen}
              onOpenChange={setDeleteOpen}
              onDeleted={() => void navigate(workspaceLink(back.href))}
            />
          </>
        ) : undefined
      }
    >
      <QueryView
        query={query}
        notFound={
          <NotFoundPage
            path={href}
            surface="inline"
            record={{
              title: m.status_l4_missing(),
              to: "/l4",
              label: m.status_back_l4(),
            }}
          />
        }
      >
        {(app) => (
          <L4WorkspaceContext.Provider
            value={{
              app,
              range: search.range ?? DEFAULT_RANGE,
              setRange,
              statsHref: viewHref("stats"),
            }}
          >
            <Outlet key={app.id} />
          </L4WorkspaceContext.Provider>
        )}
      </QueryView>
    </Page>
  );
}

export function L4WorkspaceView({ view }: { view: L4View }) {
  const workspace = React.useContext(L4WorkspaceContext);
  if (!workspace) throw new Error("L4 view must be rendered inside its detail route");
  const { app, range, setRange, statsHref } = workspace;
  if (view === "overview")
    return <L4AppOverview app={app} range={range} setRange={setRange} statsHref={statsHref} />;
  if (view === "settings") return <L4AppSettings app={app} />;
  return <L4AppStats appId={app.id} range={range} onRangeChange={setRange} />;
}

function appOption(app: L4App): ScopeOption {
  return {
    id: app.id,
    name: app.name,
    detail: `${app.protocol.toUpperCase()} ${portsLabel(app)}`,
    tone: app.enabled ? "good" : "idle",
    state: app.enabled ? m.l4_state_enabled() : m.l4_state_disabled(),
  };
}

function L4Switcher({
  app,
  rail,
  href,
  back,
}: {
  app: L4App | undefined;
  rail: boolean;
  href: (id: string) => string;
  back: { href: string; label: string };
}) {
  const search = useSwitcherSearch();
  const list = useQuery({
    ...orpc.l4Apps.list.queryOptions({ input: {} }),
    enabled: search.open,
  });
  const term = search.query.toLowerCase();
  const options = (list.data ?? [])
    .map(appOption)
    .filter((option) =>
      [option.name, option.detail ?? ""].some((value) => value.toLowerCase().includes(term)),
    );
  return (
    <ScopeSwitcher
      kind="l4"
      rail={rail}
      icon={ArrowDataTransferHorizontalIcon}
      current={app ? appOption(app) : undefined}
      label={m.scope_switch_l4()}
      searchLabel={m.scope_search_l4()}
      search={search}
      groups={[{ label: m.l4_back(), items: options }]}
      pending={list.isPending}
      retry={list.isLoadingError ? () => void list.refetch() : undefined}
      href={href}
      back={{ ...back, label: m.l4_back() }}
    />
  );
}
