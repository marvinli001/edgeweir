import { USER_AGENT_MAX_RULES, type UserAgentSettings } from "@edgeweir/contract";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  Delete02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { OptionSelect } from "@/components/form-select";
import { ListText } from "@/components/site/access-control/fields";
import { AccessPartCard, type PartFields } from "@/components/site/access-control/part-card";
import { nextDraftKey } from "@/components/site/save-site";
import { EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { m } from "@/lib/i18n";

type Action = UserAgentSettings["rules"][number]["action"];
interface Row {
  key: number;
  pattern: string;
  action: Action;
}
type Draft = Omit<UserAgentSettings, "rules"> & { rules: Row[] };

const ACTIONS = (): { value: Action; label: string }[] => [
  { value: "deny", label: m.access_ua_deny() },
  { value: "allow", label: m.access_ua_allow() },
];

/**
 * User agent rules: patterns (`*` wildcards, ASCII case-insensitive, empty for no user agent)
 * that allow or deny. Any allow match passes before the deny rules are looked at; a deny match
 * gets 403. The order is kept as written.
 */
export function UserAgentsCard({ siteId, index }: { siteId: string; index: number }) {
  return (
    <AccessPartCard
      siteId={siteId}
      part="userAgents"
      title={m.access_ua_title()}
      testId="ua"
      index={index}
      toDraft={(value): Draft => ({
        ...value,
        rules: value.rules.map((rule) => ({ ...rule, key: nextDraftKey() })),
      })}
      toPart={(draft) => ({
        ...draft,
        rules: draft.rules.map(({ pattern, action }) => ({ pattern, action })),
      })}
      inUse={(value) => value.rules.length > 0}
      labels={{
        rules: m.access_ua_title,
        pattern: m.access_ua_pattern,
        pathPrefixes: m.access_path_prefixes,
        excludePathPrefixes: m.access_exclude_prefixes,
      }}
    >
      {(fields) => <UserAgentFields {...fields} />}
    </AccessPartCard>
  );
}

function UserAgentFields({ draft, set, blocked, invalid }: PartFields<Draft>) {
  const rows = draft.rules;
  const setRows = (rules: Row[]) => set({ rules });
  const add = () => setRows([...rows, { key: nextDraftKey(), pattern: "", action: "deny" }]);
  const move = (index: number, by: number) => {
    const next = [...rows];
    const [row] = next.splice(index, 1);
    if (row) next.splice(index + by, 0, row);
    setRows(next);
  };
  if (rows.length === 0)
    return (
      <EmptyState title={m.access_ua_empty()}>
        <Button type="button" disabled={blocked} onClick={add} data-testid="ua-add-empty">
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
          {m.access_ua_add()}
        </Button>
      </EmptyState>
    );
  return (
    <>
      <div className="flex flex-col gap-3">
        <ol className="-mx-(--card-spacing) flex flex-col border-y" data-testid="ua-rules">
          {rows.map((row, index) => (
            <li
              key={row.key}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-(--card-spacing) py-3 first:border-t-0 animate-enter"
              style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
              data-testid="ua-rule"
            >
              <span className="w-5 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
                {index + 1}
              </span>
              <OptionSelect
                value={row.action}
                options={ACTIONS()}
                label={m.access_ua_action()}
                size="sm"
                className="w-28 shrink-0"
                onChange={(action) =>
                  setRows(rows.map((r, i) => (i === index ? { ...r, action } : r)))
                }
                testId="ua-rule-action"
              />
              <Input
                value={row.pattern}
                aria-label={m.access_ua_pattern()}
                placeholder={m.access_ua_empty_pattern()}
                maxLength={512}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={invalid("rules", index) || undefined}
                onChange={(event) =>
                  setRows(
                    rows.map((r, i) => (i === index ? { ...r, pattern: event.target.value } : r)),
                  )
                }
                className="order-last h-8 min-w-0 basis-full font-mono text-sm sm:order-none sm:flex-1 sm:basis-0"
                data-testid="ua-rule-pattern"
              />
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={m.auth_move_up()}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <HugeiconsIcon icon={ArrowUp01Icon} />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={m.auth_move_down()}
                  disabled={index === rows.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <HugeiconsIcon icon={ArrowDown01Icon} />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={m.common_delete()}
                  onClick={() => setRows(rows.filter((_, i) => i !== index))}
                  data-testid="ua-rule-delete"
                >
                  <HugeiconsIcon icon={Delete02Icon} />
                </Button>
              </div>
            </li>
          ))}
        </ol>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          disabled={rows.length >= USER_AGENT_MAX_RULES}
          onClick={add}
          data-testid="ua-add"
        >
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
          {m.access_ua_add()}
        </Button>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <ListText
          id="ua-prefixes"
          label={m.access_path_prefixes()}
          value={draft.pathPrefixes}
          placeholder="/api/"
          invalid={invalid("pathPrefixes")}
          onChange={(pathPrefixes) => set({ pathPrefixes })}
          testId="ua-prefixes"
        />
        <ListText
          id="ua-excludes"
          label={m.access_exclude_prefixes()}
          value={draft.excludePathPrefixes}
          placeholder="/robots.txt"
          invalid={invalid("excludePathPrefixes")}
          onChange={(excludePathPrefixes) => set({ excludePathPrefixes })}
          testId="ua-excludes"
        />
      </div>
    </>
  );
}
