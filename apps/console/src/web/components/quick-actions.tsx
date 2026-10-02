import {
  type BanScope,
  banLookupCidr,
  WAF_MAX_EXCLUSIONS,
  wafExcludedRuleIds,
} from "@edgeweir/contract";
import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import { BanDialog } from "@/components/ban-dialog";
import { ControlledConfirmDialog } from "@/components/confirm-dialog";
import { ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { m } from "@/lib/i18n";
import { client, orpc } from "@/lib/orpc";
import { expandPurgeTargets } from "@/lib/purge";
import { cn } from "@/lib/utils";

/**
 * Something done where the data is (a log row, a top list, an event, ⌘K): it runs in place in a
 * prefilled dialog or after a confirmation, without leaving the page.
 */
export type QuickAction =
  /** The ban dialog, with the address and site (or scope) filled in. */
  | { kind: "ban"; address?: string; siteId?: string; scope?: BanScope }
  /** Lifts the site's bans of exactly this address. */
  | { kind: "unban"; address: string; siteId: string }
  /** A URL purge; paths expand to the site's domains that are not wildcards. */
  | { kind: "purge"; targets: string[]; siteId?: string }
  /** Adds a CRS rule to the site's exclusions. */
  | { kind: "exclude-rule"; siteId: string; ruleId: number }
  /** Turns the site's Under Attack the other way. */
  | { kind: "under-attack"; siteId: string; siteName: string }
  /** Turns Under Attack for every site the other way. */
  | { kind: "platform-under-attack" }
  /** Purges everything the site has cached (a node task). */
  | { kind: "purge-site"; siteId: string; siteName: string };

const QuickActionsContext = React.createContext<((action: QuickAction) => void) | null>(null);

/** Starts a quick action (inside QuickActionsProvider). */
export function useQuickActions(): (action: QuickAction) => void {
  const run = React.useContext(QuickActionsContext);
  if (!run) throw new Error("useQuickActions needs a QuickActionsProvider");
  return run;
}

/** Holds the one dialog of the quick action in progress, for every page of the console. */
export function QuickActionsProvider({ children }: { children: React.ReactNode }) {
  // The last action stays while its dialog closes; each start gets a fresh dialog.
  const [state, setState] = React.useState<{
    action: QuickAction | null;
    open: boolean;
    key: number;
  }>({ action: null, open: false, key: 0 });
  const run = React.useCallback(
    (action: QuickAction) => setState((prev) => ({ action, open: true, key: prev.key + 1 })),
    [],
  );
  const onOpenChange = React.useCallback((open: boolean) => {
    if (!open) setState((prev) => ({ ...prev, open: false }));
  }, []);
  return (
    <QuickActionsContext.Provider value={run}>
      {children}
      {state.action ? (
        <QuickActionDialog
          key={state.key}
          action={state.action}
          open={state.open}
          onOpenChange={onOpenChange}
        />
      ) : null}
    </QuickActionsContext.Provider>
  );
}

export interface RowMenuItem {
  label: string;
  action: QuickAction;
  testId?: string;
}

/** The ⋯ menu of a row: its quick actions. Renders nothing without items. */
export function RowMenu({ items, className }: { items: RowMenuItem[]; className?: string }) {
  const run = useQuickActions();
  if (items.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            className={cn("-my-1 shrink-0", className)}
            aria-label={m.common_actions()}
            data-testid="row-actions"
          />
        }
      >
        <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((item) => (
          <DropdownMenuItem
            key={item.label}
            onClick={() => run(item.action)}
            data-testid={item.testId}
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * CRS rules that only evaluate the others (initialization, blocking evaluation, correlation):
 * excluding one would turn blocking off for the whole site, so no menu offers it.
 */
export function excludableCrsRule(id: number): boolean {
  const file = Math.floor(id / 1000);
  return ![901, 949, 959, 980].includes(file);
}

interface DialogProps<K extends QuickAction["kind"]> {
  action: Extract<QuickAction, { kind: K }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function QuickActionDialog({
  action,
  open,
  onOpenChange,
}: {
  action: QuickAction;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  switch (action.kind) {
    case "ban":
      return (
        <BanDialog
          open={open}
          onOpenChange={onOpenChange}
          address={action.address}
          siteId={action.siteId}
          scope={action.scope}
        />
      );
    case "unban":
      return <UnbanConfirm action={action} open={open} onOpenChange={onOpenChange} />;
    case "purge":
      return <PurgeConfirm action={action} open={open} onOpenChange={onOpenChange} />;
    case "exclude-rule":
      return <ExcludeRuleConfirm action={action} open={open} onOpenChange={onOpenChange} />;
    case "under-attack":
      return <UnderAttackConfirm action={action} open={open} onOpenChange={onOpenChange} />;
    case "platform-under-attack":
      return <PlatformUnderAttackConfirm action={action} open={open} onOpenChange={onOpenChange} />;
    case "purge-site":
      return <PurgeSiteConfirm action={action} open={open} onOpenChange={onOpenChange} />;
  }
}

function UnbanConfirm({ action, open, onOpenChange }: DialogProps<"unban">) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return (
    <ControlledConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.bans_unban_confirm({ address: action.address })}
      confirmLabel={m.bans_unban()}
      onConfirm={async () => {
        const cidr = banLookupCidr(action.address);
        const { items } = await client.bans.list({
          siteId: action.siteId,
          address: action.address,
          pageSize: 100,
        });
        // Only bans of exactly this address: a range that covers it stays.
        const bans = items.filter((ban) => ban.siteId === action.siteId && ban.cidr === cidr);
        if (bans.length === 0) throw new Error(m.quick_unban_none());
        for (const ban of bans) await client.bans.delete({ id: ban.id });
        await queryClient.invalidateQueries({ queryKey: orpc.bans.key() });
        toast.success(m.bans_unbanned(), {
          action: {
            label: m.bans_view(),
            onClick: () => void navigate({ to: "/bans", search: { site: action.siteId } }),
          },
        });
      }}
    />
  );
}

function PurgeConfirm({ action, open, onOpenChange }: DialogProps<"purge">) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const paths = action.targets.some((target) => target.startsWith("/"));
  const site = useQuery({
    ...orpc.sites.get.queryOptions({ input: { id: action.siteId ?? "" } }),
    enabled: paths && !!action.siteId,
  });
  const { urls } = expandPurgeTargets(action.targets, site.data?.domains ?? []);
  const ready = !paths || !action.siteId || site.data !== undefined || site.isLoadingError;
  return (
    <ControlledConfirmDialog
      open={open && ready}
      onOpenChange={onOpenChange}
      title={m.quick_purge_confirm({ count: urls.length })}
      confirmLabel={m.purge_submit()}
      destructive={false}
      onConfirm={async () => {
        if (urls.length === 0) throw new Error(m.quick_purge_nothing());
        await client.cacheTasks.create({ type: "url", urls });
        await queryClient.invalidateQueries({ queryKey: orpc.cacheTasks.key() });
        toast.success(m.purge_submitted(), {
          action: {
            label: m.purge_view_tasks(),
            onClick: () =>
              void navigate({
                to: "/purge",
                search: action.siteId ? { site: action.siteId } : {},
              }),
          },
        });
      }}
    >
      {site.isLoadingError ? (
        <ErrorState error={site.error} onRetry={() => void site.refetch()} />
      ) : urls.length ? (
        <ul
          className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-xl bg-muted/50 px-3 py-2 font-mono text-xs"
          data-testid="quick-purge-urls"
        >
          {urls.map((url) => (
            <li key={url} className="break-all">
              {url}
            </li>
          ))}
        </ul>
      ) : null}
    </ControlledConfirmDialog>
  );
}

function ExcludeRuleConfirm({ action, open, onOpenChange }: DialogProps<"exclude-rule">) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const id = String(action.ruleId);
  return (
    <ControlledConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.quick_exclude_confirm({ id })}
      confirmLabel={m.waf_exclusions_add()}
      onConfirm={async () => {
        // The exclusions as saved now: the update replaces the whole list.
        const waf = await client.waf.get({ id: action.siteId });
        const next = [...new Set([...waf.excludedRuleIds, action.ruleId])].sort((a, b) => a - b);
        if (!wafExcludedRuleIds.safeParse(next).success)
          throw new Error(m.waf_exclusions_invalid({ max: WAF_MAX_EXCLUSIONS }));
        const saved =
          next.length === waf.excludedRuleIds.length
            ? waf
            : await client.waf.update({ id: action.siteId, excludedRuleIds: next });
        queryClient.setQueryData(orpc.waf.get.queryKey({ input: { id: action.siteId } }), saved);
        toast.success(m.quick_rule_excluded({ id }), {
          action: {
            label: m.waf_view(),
            onClick: () =>
              void navigate({
                to: "/sites/$id",
                params: { id: action.siteId },
                search: { tab: "security" },
                hash: "security-waf",
              }),
          },
        });
      }}
    />
  );
}

function UnderAttackConfirm({ action, open, onOpenChange }: DialogProps<"under-attack">) {
  const queryClient = useQueryClient();
  const protection = useQuery(orpc.protection.get.queryOptions({ input: { id: action.siteId } }));
  const turningOn = !protection.data?.underAttack;
  return (
    <ControlledConfirmDialog
      open={open && !protection.isPending}
      onOpenChange={onOpenChange}
      title={
        turningOn
          ? m.protection_under_attack_on_site({ name: action.siteName })
          : m.protection_under_attack_off_site({ name: action.siteName })
      }
      note={turningOn ? m.protection_under_attack_on_note() : undefined}
      confirmLabel={turningOn ? m.protection_turn_on() : m.protection_turn_off()}
      destructive={turningOn}
      onConfirm={async () => {
        if (!protection.data) throw protection.error ?? new Error(m.common_unknown_error());
        const saved = await client.protection.update({
          id: action.siteId,
          underAttack: turningOn,
        });
        queryClient.setQueryData(
          orpc.protection.get.queryKey({ input: { id: action.siteId } }),
          saved,
        );
        toast.success(m.common_saved());
      }}
    >
      {protection.isLoadingError ? <ErrorState error={protection.error} /> : null}
    </ControlledConfirmDialog>
  );
}

function PlatformUnderAttackConfirm({ open, onOpenChange }: DialogProps<"platform-under-attack">) {
  const queryClient = useQueryClient();
  const settings = useQuery(orpc.settings.protection.queryOptions());
  const turningOn = !settings.data?.underAttack;
  return (
    <ControlledConfirmDialog
      open={open && !settings.isPending}
      onOpenChange={onOpenChange}
      title={turningOn ? m.protection_platform_on_confirm() : m.protection_platform_off_confirm()}
      note={m.protection_platform_note()}
      confirmLabel={turningOn ? m.protection_turn_on() : m.protection_turn_off()}
      destructive={turningOn}
      onConfirm={async () => {
        if (!settings.data) throw settings.error ?? new Error(m.common_unknown_error());
        await client.settings.setProtection({ ...settings.data, underAttack: turningOn });
        await queryClient.invalidateQueries({ queryKey: orpc.settings.protection.key() });
        await queryClient.invalidateQueries({ queryKey: orpc.protection.key() });
        toast.success(m.common_saved());
      }}
    >
      {settings.isLoadingError ? <ErrorState error={settings.error} /> : null}
    </ControlledConfirmDialog>
  );
}

function PurgeSiteConfirm({ action, open, onOpenChange }: DialogProps<"purge-site">) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return (
    <ControlledConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.sites_purge_confirm({ name: action.siteName })}
      confirmLabel={m.sites_purge()}
      onConfirm={async () => {
        await client.sites.purgeAll({ id: action.siteId });
        await queryClient.invalidateQueries({ queryKey: orpc.cacheTasks.key() });
        toast.success(m.sites_purged(), {
          action: {
            label: m.purge_view_tasks(),
            onClick: () => void navigate({ to: "/purge", search: { site: action.siteId } }),
          },
        });
      }}
    />
  );
}
