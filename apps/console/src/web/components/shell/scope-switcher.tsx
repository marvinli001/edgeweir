import { ArrowDown01Icon, ArrowUp01Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { Button } from "@/components/arc/button/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/arc/popover/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/arc/tooltip/tooltip";
import { SearchField } from "@/components/layout/search-field";
import { Spinner } from "@/components/layout/spinner";
import { Dot, type StatusTone } from "@/components/status-dot";
import { m } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { workspaceLink } from "@/lib/workspace-link";

export interface ScopeOption {
  id: string;
  name: string;
  tone: StatusTone;
  state: string;
  detail?: string;
}

interface OptionGroup {
  label: string;
  items: readonly ScopeOption[];
}

export function useSwitcherSearch(delay = 0) {
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState("");
  const [settled, setSettled] = React.useState("");
  const commit = () => setSettled(text.trim());
  React.useEffect(() => {
    if (!delay) return;
    const timer = window.setTimeout(() => setSettled(text.trim()), delay);
    return () => window.clearTimeout(timer);
  }, [delay, text]);
  return {
    open,
    setOpen: (next: boolean) => {
      setOpen(next);
      if (!next) {
        setText("");
        setSettled("");
      }
    },
    text,
    setText,
    query: delay ? settled : text.trim(),
    waiting: !!delay && text.trim() !== settled,
    commit,
  };
}

export function ScopeSwitcher({
  kind,
  rail,
  icon,
  current,
  label,
  searchLabel,
  search,
  groups,
  pending,
  retry,
  href,
  back,
}: {
  kind: string;
  rail: boolean;
  icon: IconSvgElement;
  current: ScopeOption | undefined;
  label: string;
  searchLabel: string;
  search: ReturnType<typeof useSwitcherSearch>;
  groups: readonly OptionGroup[];
  pending?: boolean;
  retry?: () => void;
  href: (id: string) => string;
  back: { href: string; label: string };
}) {
  const navigate = useNavigate();
  const input = React.useRef<HTMLInputElement>(null);
  const afterClose = React.useRef<string | undefined>(undefined);
  const listId = React.useId();
  const options = groups.flatMap((group) => group.items);
  const [highlight, setHighlight] = React.useState<string>();
  const picked = options.find((option) => option.id === highlight) ?? options[0];
  const activeId = picked && !search.waiting ? `${listId}-${picked.id}` : undefined;
  React.useEffect(() => {
    if (search.open && activeId) {
      document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
    }
  }, [activeId, search.open]);

  function follow(url?: string) {
    afterClose.current = url;
    search.setOpen(false);
  }

  function choose(id: string) {
    if (!search.waiting) follow(id === current?.id ? undefined : href(id));
  }

  const trigger = (
    <PopoverTrigger
      render={<button type="button" />}
      className={cn(
        "flex h-9 w-full items-center gap-2 rounded-md border border-input bg-sidebar px-2.5 text-left hover:bg-wash focus-ring pointer-coarse:min-h-11",
        rail && "justify-center px-0",
      )}
      aria-label={
        current ? m.scope_choose_named({ label, name: current.name, state: current.state }) : label
      }
      title={rail ? undefined : current?.name}
      data-testid={`${kind}-nav-switcher`}
    >
      {rail ? (
        <HugeiconsIcon icon={icon} size={18} strokeWidth={1.75} aria-hidden />
      ) : (
        <>
          {current ? <Dot tone={current.tone} /> : <Spinner />}
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{current?.name}</span>
          <span className="grid shrink-0 text-muted-foreground" aria-hidden>
            <HugeiconsIcon icon={ArrowUp01Icon} size={12} />
            <HugeiconsIcon icon={ArrowDown01Icon} size={12} />
          </span>
        </>
      )}
    </PopoverTrigger>
  );

  return (
    <Popover
      open={search.open}
      onOpenChange={(open) => {
        search.setOpen(open);
        if (open) setHighlight(current?.id);
      }}
      onOpenChangeComplete={(open) => {
        if (open) return;
        const url = afterClose.current;
        afterClose.current = undefined;
        if (url) void navigate(workspaceLink(url));
      }}
    >
      {rail ? (
        <Tooltip>
          <TooltipTrigger render={trigger} />
          <TooltipContent side="right">{current?.name ?? label}</TooltipContent>
        </Tooltip>
      ) : (
        trigger
      )}
      <PopoverContent
        side={rail ? "right" : "bottom"}
        initialFocus={input}
        aria-label={label}
        className="grid w-72 min-w-0 gap-2"
        data-testid={`${kind}-switcher-panel`}
      >
        <SearchField
          ref={input}
          value={search.text}
          maxLength={100}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-label={searchLabel}
          placeholder={searchLabel}
          onChange={(event) => {
            search.setText(event.target.value);
            setHighlight(undefined);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const index = picked ? options.indexOf(picked) : 0;
              const next = index + (event.key === "ArrowDown" ? 1 : -1);
              setHighlight(options[Math.min(options.length - 1, Math.max(0, next))]?.id);
            }
            if (event.key === "Enter") {
              event.preventDefault();
              if (search.waiting) search.commit();
              else if (picked) choose(picked.id);
            }
          }}
        />
        {search.waiting || pending ? (
          <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground" role="status">
            <Spinner /> {m.common_loading()}
          </div>
        ) : null}
        {retry ? (
          <div role="alert" className="flex items-center justify-between gap-2 px-2 text-xs">
            {m.scope_load_failed()}
            <Button variant="ghost" size="sm" onClick={retry}>
              {m.common_retry()}
            </Button>
          </div>
        ) : null}
        <div
          id={listId}
          role="listbox"
          aria-label={label}
          aria-busy={search.waiting || pending}
          className="max-h-80 overflow-y-auto"
        >
          {groups
            .filter((group) => group.items.length > 0)
            .map((group) => (
              <fieldset key={group.label} className="min-w-0">
                <legend className="px-2 py-1.5 text-xs text-muted-foreground">{group.label}</legend>
                {group.items.map((option) => (
                  <button
                    key={option.id}
                    id={`${listId}-${option.id}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={option.id === picked?.id}
                    aria-current={option.id === current?.id ? "page" : undefined}
                    className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-wash focus-ring aria-selected:bg-wash aria-[current=page]:text-primary-ink pointer-coarse:min-h-11"
                    disabled={search.waiting}
                    onPointerMove={() => setHighlight(option.id)}
                    onClick={() => choose(option.id)}
                  >
                    <Dot tone={option.tone} />
                    <span className="sr-only">{option.state}</span>
                    <span className="min-w-0 flex-1 truncate font-mono" title={option.name}>
                      {option.name}
                    </span>
                    {option.detail ? (
                      <span
                        className="max-w-32 truncate font-mono text-xs text-muted-foreground"
                        title={option.detail}
                      >
                        {option.detail}
                      </span>
                    ) : null}
                    {option.id === current?.id ? (
                      <HugeiconsIcon icon={CheckmarkCircle02Icon} size={16} aria-hidden />
                    ) : null}
                  </button>
                ))}
              </fieldset>
            ))}
        </div>
        {!options.length && !pending && !retry && !search.waiting ? (
          <div className="rounded-md bg-well px-2 py-3 text-sm text-muted-foreground">
            {m.scope_no_matches()}
          </div>
        ) : null}
        <Link
          {...workspaceLink(back.href)}
          className="flex min-h-9 items-center border-t px-2 text-sm font-medium text-primary-ink focus-ring pointer-coarse:min-h-11"
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            follow(back.href);
          }}
        >
          {back.label}
        </Link>
      </PopoverContent>
    </Popover>
  );
}
