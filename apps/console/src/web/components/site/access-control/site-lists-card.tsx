import type { IpListDto, SiteListSettings } from "@edgeweir/contract";
import { Add01Icon, ListViewIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { IpListKind } from "@/components/ip-check";
import { enterDelay } from "@/components/page";
import { AccessPartCard, type PartFields } from "@/components/site/access-control/part-card";
import { EmptyState, QueryView } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldLegend, FieldSet } from "@/components/ui/field";
import { formatNumber, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

/**
 * The IP lists that block (403) or let through the site's visitors, on top of the global ones. A
 * list is on one side at most: the other side's checkbox waits.
 */
export function SiteListsCard({ siteId, index }: { siteId: string; index: number }) {
  return (
    <AccessPartCard
      siteId={siteId}
      part="siteLists"
      title={m.access_site_lists_title()}
      testId="site-lists"
      index={index}
      toDraft={(value) => value}
      toPart={(draft) => draft}
      inUse={(value) => value.blockListIds.length > 0 || value.allowListIds.length > 0}
      labels={{
        blockListIds: m.access_site_block_lists,
        allowListIds: m.access_site_allow_lists,
      }}
    >
      {(fields) => <SiteListsFields {...fields} />}
    </AccessPartCard>
  );
}

function SiteListsFields({ draft, set, blocked }: PartFields<SiteListSettings>) {
  const lists = useQuery(orpc.ipLists.list.queryOptions());
  return (
    <QueryView
      query={lists}
      empty={
        <EmptyState icon={ListViewIcon} art="checkpoint" title={m.ip_lists_empty()}>
          <Button
            render={<Link to="/ip-lists" />}
            nativeButton={false}
            data-testid="site-lists-create"
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.ip_lists_create()}
          </Button>
        </EmptyState>
      }
    >
      {(all) => (
        <div className="grid min-w-0 gap-4 md:grid-cols-2">
          <ListPicker
            id="site-block-lists"
            legend={m.access_site_block_lists()}
            lists={all}
            value={draft.blockListIds}
            taken={draft.allowListIds}
            disabled={blocked}
            onChange={(blockListIds) => set({ blockListIds })}
          />
          <ListPicker
            id="site-allow-lists"
            legend={m.access_site_allow_lists()}
            lists={all}
            value={draft.allowListIds}
            taken={draft.blockListIds}
            disabled={blocked}
            onChange={(allowListIds) => set({ allowListIds })}
          />
        </div>
      )}
    </QueryView>
  );
}

/** Checkboxes over the IP lists (name, kind, size); lists `taken` by the other side wait. */
function ListPicker({
  id,
  legend,
  lists,
  value,
  taken,
  disabled,
  onChange,
}: {
  id: string;
  legend: string;
  lists: IpListDto[];
  value: string[];
  taken: string[];
  disabled: boolean;
  onChange: (value: string[]) => void;
}) {
  return (
    <FieldSet className="min-w-0 gap-0" data-testid={id}>
      <FieldLegend variant="label" className="flex w-full items-center justify-between gap-2">
        <span>{legend}</span>
        <span
          className="text-xs font-normal tabular-nums text-muted-foreground"
          data-testid={`${id}-count`}
        >
          {formatNumber(value.length)}
        </span>
      </FieldLegend>
      <div className="max-h-72 min-w-0 divide-y divide-border/70 overflow-y-auto rounded-2xl sunk-well">
        {lists.map((list, index) => {
          const off = disabled || taken.includes(list.id);
          const checked = value.includes(list.id);
          return (
            // biome-ignore lint/a11y/noLabelWithoutControl: the Base UI checkbox inside is the control
            <label
              key={list.id}
              className="flex min-w-0 cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors animate-enter hover:bg-wash has-data-checked:bg-tint-primary has-data-disabled:cursor-not-allowed has-data-disabled:opacity-60 has-data-disabled:hover:bg-transparent"
              style={enterDelay(index)}
              data-testid={`${id}-${list.name}`}
            >
              <Checkbox
                checked={checked}
                disabled={off && !checked}
                onCheckedChange={(next) =>
                  onChange(next ? [...value, list.id] : value.filter((v) => v !== list.id))
                }
              />
              <span className="min-w-0 truncate font-mono text-sm">{`$${list.name}`}</span>
              <IpListKind kind={list.kind} />
              <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                {m.ip_lists_count({ count: formatNumber(list.entries.length) })}
              </span>
            </label>
          );
        })}
      </div>
    </FieldSet>
  );
}
