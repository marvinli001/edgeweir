import {
  MAX_SITE_TAGS,
  type SiteTag,
  type SiteTagRef,
  tagKey,
  tagName,
  uniqueTagNames,
} from "@edgeweir/contract";
import { Cancel01Icon, Delete02Icon, Edit02Icon, Tag01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/arc/dialog/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/arc/dropdown-menu/dropdown-menu";
import { Input } from "@/components/arc/input/input";
import { ControlledConfirmDialog } from "@/components/confirm-dialog";
import { FieldError } from "@/components/layout/form";
import { Spinner } from "@/components/layout/spinner";
import { enterDelay } from "@/components/page";
import { EmptyState, QueryView } from "@/components/states";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

/** A site's tags as small chips; with `onSelect` each one is a button (e.g. to filter by it). */
export function TagBadges({
  tags,
  onSelect,
  className,
}: {
  tags: readonly SiteTagRef[];
  onSelect?: (tag: SiteTagRef) => void;
  className?: string;
}) {
  if (!tags.length) return null;
  return (
    <span className={cn("flex flex-wrap gap-1", className)} data-testid="site-tags">
      {tags.map((tag) =>
        onSelect ? (
          <button
            key={tag.id}
            type="button"
            onClick={() => onSelect(tag)}
            className="max-w-40 cursor-pointer rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
            data-testid="site-tag"
          >
            <Badge size="sm" tone="neutral" className="max-w-full truncate">
              {tag.name}
            </Badge>
          </button>
        ) : (
          <Badge
            size="sm"
            key={tag.id}
            tone="neutral"
            className="max-w-40 truncate"
            data-testid="site-tag"
          >
            {tag.name}
          </Badge>
        ),
      )}
    </span>
  );
}

/** Every tag, for suggestions and filters (fresh for a minute). */
export function useSiteTags(enabled = true) {
  return useQuery({ ...orpc.siteTags.list.queryOptions(), enabled, staleTime: 60_000 });
}

/**
 * Picks tag names: chips with a remove button, an input that adds what is typed on Enter or a
 * comma, and existing tags that match it as suggestions. Names repeat in no case.
 */
export function TagPicker({
  id,
  value,
  onChange,
  max = MAX_SITE_TAGS,
  testId = "tag-picker",
  onDraftChange,
}: {
  id: string;
  value: readonly string[];
  onChange: (names: string[]) => void;
  max?: number;
  testId?: string;
  /** What is typed but not added yet (leaving the field adds it). */
  onDraftChange?: (text: string) => void;
}) {
  const [text, setTextState] = React.useState("");
  const setText = (next: string) => {
    setTextState(next);
    onDraftChange?.(next);
  };
  const [invalid, setInvalid] = React.useState<string | null>(null);
  const tags = useSiteTags();
  const chosen = new Set(value.map(tagKey));
  const typed = tagKey(text);
  const suggestions = (tags.data ?? [])
    .filter((tag) => !chosen.has(tagKey(tag.name)) && tagKey(tag.name).includes(typed))
    .slice(0, 8);
  /**
   * Adds the names (typed, pasted as a list or picked) in one change, so that none of a pasted
   * list is lost; the first invalid name or the limit stops it with a message.
   */
  const add = (raws: readonly string[]) => {
    let next = [...value];
    let problem: string | null = null;
    for (const raw of raws) {
      if (!raw.trim()) continue;
      const parsed = tagName.safeParse(raw);
      if (!parsed.success) {
        problem = m.tags_invalid();
        break;
      }
      if (next.some((name) => tagKey(name) === tagKey(parsed.data))) continue;
      if (next.length >= max) {
        problem = m.tags_limit({ max });
        break;
      }
      // An existing tag keeps its name as first written.
      const existing = (tags.data ?? []).find((tag) => tagKey(tag.name) === tagKey(parsed.data));
      next = uniqueTagNames([...next, existing?.name ?? parsed.data]);
    }
    if (next.length !== value.length) onChange(next);
    setInvalid(problem);
    return problem === null;
  };
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-input px-2 py-1.5 focus-within:ring-[3px] focus-within:ring-ring/50">
        {value.map((name) => (
          <Badge
            size="sm"
            key={tagKey(name)}
            tone="neutral"
            className="gap-1 pr-1"
            data-testid="tag-chip"
          >
            <span className="max-w-40 truncate">{name}</span>
            <button
              type="button"
              className="rounded-full p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              aria-label={m.tags_remove({ name })}
              onClick={() => onChange(value.filter((other) => tagKey(other) !== tagKey(name)))}
            >
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3" />
            </button>
          </Badge>
        ))}
        <input
          id={id}
          value={text}
          maxLength={64}
          className="min-w-24 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          placeholder={value.length ? "" : m.tags_add_placeholder()}
          aria-invalid={invalid ? true : undefined}
          onChange={(event) => {
            setInvalid(null);
            const next = event.target.value;
            // A comma ends a name, as Enter does (also for pasted lists).
            if (next.includes(",") || next.includes("，")) {
              const parts = next.split(/[,，]/);
              add(parts.slice(0, -1));
              setText(parts.at(-1) ?? "");
            } else setText(next);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (text.trim() && add([text])) setText("");
            } else if (event.key === "Backspace" && text === "" && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => {
            if (text.trim() && add([text])) setText("");
          }}
          data-testid={`${testId}-input`}
        />
      </div>
      {suggestions.length ? (
        <div className="flex flex-wrap gap-1">
          {suggestions.map((tag) => (
            <button
              key={tag.id}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => add([tag.name])}
              className="cursor-pointer rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
              data-testid="tag-suggestion"
            >
              <Badge size="sm" tone="neutral">
                {tag.name}
              </Badge>
            </button>
          ))}
        </div>
      ) : null}
      {invalid ? (
        <FieldError className="animate-in fade-in" data-testid={`${testId}-error`}>
          {invalid}
        </FieldError>
      ) : null}
    </div>
  );
}

/** The site list's tag filter: any or all of the chosen tags. */
export function TagFilter({
  tags,
  selected,
  match,
  onChange,
}: {
  tags: readonly SiteTag[];
  selected: readonly string[];
  match: "any" | "all";
  onChange: (next: { selected: string[]; match: "any" | "all" }) => void;
}) {
  const names = tags.filter((tag) => selected.includes(tag.id)).map((tag) => tag.name);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="secondary"
            className={cn("w-full justify-start sm:w-auto", selected.length && "text-foreground")}
            data-testid="tag-filter"
          />
        }
      >
        <HugeiconsIcon icon={Tag01Icon} strokeWidth={2} />
        <span className="max-w-48 truncate">
          {names.length ? names.join(match === "all" ? " + " : " / ") : m.tags_filter()}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        {tags.length === 0 ? (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">{m.tags_manage_empty()}</p>
        ) : (
          <>
            <DropdownMenuGroup>
              {tags.map((tag) => (
                <DropdownMenuCheckboxItem
                  key={tag.id}
                  checked={selected.includes(tag.id)}
                  // The list filters by at most as many tags as a site carries.
                  disabled={!selected.includes(tag.id) && selected.length >= MAX_SITE_TAGS}
                  closeOnClick={false}
                  onCheckedChange={(checked) =>
                    onChange({
                      match,
                      selected: checked
                        ? [...selected, tag.id]
                        : selected.filter((id) => id !== tag.id),
                    })
                  }
                  data-testid="tag-filter-option"
                >
                  <span className="truncate">{tag.name}</span>
                  <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                    {tag.sites}
                  </span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuRadioGroup
              value={match}
              onValueChange={(value) =>
                onChange({ selected: [...selected], match: value === "all" ? "all" : "any" })
              }
            >
              <DropdownMenuRadioItem value="any" closeOnClick={false} data-testid="tag-match-any">
                {m.tags_filter_any()}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="all" closeOnClick={false} data-testid="tag-match-all">
                {m.tags_filter_all()}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Rename and delete tags (a rename onto another tag's name merges the two). */
export function TagManagerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tags = useSiteTags(open);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{m.tags_manage()}</DialogTitle>
        </DialogHeader>
        <QueryView
          query={tags}
          loadingClassName="min-h-36"
          isEmpty={(data) => data.length === 0}
          empty={<EmptyState icon={Tag01Icon} title={m.tags_manage_empty()} />}
        >
          {(data) => (
            <ul
              // min-w-0: a long tag name must not widen the dialog's grid column (it truncates).
              className="min-w-0 divide-y divide-border/70 rounded-lg faint-well"
              data-testid="tag-manager"
            >
              {data.map((tag, index) => (
                <TagRow key={tag.id} tag={tag} index={index} />
              ))}
            </ul>
          )}
        </QueryView>
      </DialogContent>
    </Dialog>
  );
}

function TagRow({ tag, index }: { tag: SiteTag; index: number }) {
  const [editing, setEditing] = React.useState(false);
  const [name, setName] = React.useState(tag.name);
  const [error, setError] = React.useState<string | null>(null);
  const [confirming, setConfirming] = React.useState(false);
  const meta = { invalidates: [orpc.siteTags.key(), orpc.sites.key()] };
  const rename = useMutation({ ...orpc.siteTags.rename.mutationOptions(), meta });
  const remove = useMutation({ ...orpc.siteTags.delete.mutationOptions(), meta });
  return (
    <li
      className="flex flex-col gap-2 px-3 py-2.5 animate-enter"
      style={enterDelay(index)}
      data-testid="tag-row"
    >
      {editing ? (
        <form
          className="flex items-center gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const parsed = tagName.safeParse(name);
            if (!parsed.success) {
              setError(m.tags_invalid());
              return;
            }
            try {
              await rename.mutateAsync({ id: tag.id, name: parsed.data });
              setEditing(false);
              setError(null);
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        >
          <Input
            value={name}
            autoFocus
            maxLength={64}
            aria-label={m.tags_rename()}
            onChange={(event) => setName(event.target.value)}
            data-testid="tag-rename-input"
          />
          <Button type="submit" size="sm" disabled={rename.isPending} data-testid="tag-rename-save">
            {rename.isPending ? <Spinner /> : null}
            {m.common_save()}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditing(false);
              setName(tag.name);
              setError(null);
            }}
          >
            {m.common_cancel()}
          </Button>
        </form>
      ) : (
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium" data-testid="tag-row-name">
            {tag.name}
          </span>
          <span className="shrink-0 text-xs whitespace-nowrap tabular-nums text-muted-foreground">
            {m.tags_sites_count({ count: tag.sites })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="icon-button ml-auto"
            aria-label={m.tags_rename()}
            onClick={() => setEditing(true)}
            data-testid="tag-rename"
          >
            <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} />
          </Button>
          <Button
            className="icon-button"
            size="sm"
            variant="ghost"
            aria-label={m.common_delete()}
            onClick={() => setConfirming(true)}
            data-testid="tag-delete"
          >
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
          </Button>
        </div>
      )}
      {error ? (
        <FieldError className="animate-in fade-in" data-testid="tag-row-error">
          {error}
        </FieldError>
      ) : null}
      <ControlledConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={m.tags_delete_confirm({ name: tag.name })}
        note={tag.sites ? m.tags_delete_note({ count: tag.sites }) : undefined}
        confirmLabel={m.common_delete()}
        onConfirm={async () => {
          await remove.mutateAsync({ id: tag.id });
        }}
      />
    </li>
  );
}
