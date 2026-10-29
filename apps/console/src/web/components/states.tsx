import { type InboxIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { Alert } from "@/components/arc/alert/alert";
import { Button } from "@/components/arc/button/button";
import { EmptyState as ArcEmptyState } from "@/components/arc/empty-state/empty-state";
import { LoadingState } from "@/components/loading-state";
import { m } from "@/lib/i18n";
import { errorMessage, isNotFound } from "@/lib/orpc";

export { LoadingState };

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <Alert tone="danger" title={m.common_error_title()} className="animate-enter">
      {onRetry ? (
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span className="min-w-0">{errorMessage(error, m.common_unknown_error())}</span>
          <Button size="sm" variant="secondary" onClick={onRetry}>
            {m.common_retry()}
          </Button>
        </span>
      ) : (
        errorMessage(error, m.common_unknown_error())
      )}
    </Alert>
  );
}

/**
 * Nothing to show yet (Arc's empty state): a small icon, one line and an optional action, centered
 * (a table's or a tab's list). `compact` is an empty section inside a panel: the line and its
 * action side by side. No description.
 */
export function EmptyState({
  title,
  icon,
  compact = false,
  children,
}: {
  title: string;
  icon?: typeof InboxIcon;
  compact?: boolean;
  children?: React.ReactNode;
}) {
  if (compact)
    return (
      <div
        className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md bg-well px-4 py-2.5 text-sm text-muted-foreground"
        data-slot="empty"
      >
        <span>{title}</span>
        {children}
      </div>
    );
  return (
    <div data-slot="empty">
      <ArcEmptyState
        title={title}
        icon={icon ? <HugeiconsIcon icon={icon} size={24} strokeWidth={1.5} /> : undefined}
        action={children}
      />
    </div>
  );
}

/**
 * A filtered list that matches nothing, as opposed to one with nothing in it yet: the search icon,
 * one line and the way back to the whole list. `compact` inside a panel, like EmptyState.
 */
export function NoMatch({
  title,
  onClear,
  compact = false,
  testId = "clear-filters",
}: {
  title: string;
  onClear: () => void;
  compact?: boolean;
  testId?: string;
}) {
  return (
    <EmptyState title={title} icon={Search01Icon} compact={compact}>
      <Button size="sm" variant="secondary" onClick={onClear} data-testid={testId}>
        {m.common_clear_filters()}
      </Button>
    </EmptyState>
  );
}

/** What QueryView reads of a TanStack query (or of `combineQueries`). */
export interface QueryResult<T> {
  isPending: boolean;
  isLoadingError: boolean;
  error: unknown;
  data: T | undefined;
  refetch: () => unknown;
}

const noItems = (data: unknown) => Array.isArray(data) && data.length === 0;

/**
 * A query's first load (LoadingState), its first load failing (ErrorState with a retry), then its
 * data; `empty` instead when `isEmpty` says the data holds nothing (by default an array without
 * items). A failed background refetch keeps showing the data: that is `isError`, not
 * `isLoadingError`. `frame` wraps the loading and error states, e.g. PanelContent in a panel whose
 * loaded content brings its own; `error` replaces ErrorState where a failure is an answer rather
 * than a hiccup (a refused rollback), `notFound` where the record no longer exists (404).
 * `children` gets the data; it must not call hooks.
 */
export function QueryView<T>({
  query,
  children,
  empty,
  isEmpty = noItems,
  loadingClassName,
  frame: Frame,
  error,
  notFound,
}: {
  query: QueryResult<T>;
  children: (data: T) => React.ReactNode;
  empty?: React.ReactNode;
  isEmpty?: (data: T) => boolean;
  loadingClassName?: string;
  frame?: React.ComponentType<{ children?: React.ReactNode }>;
  error?: (error: unknown) => React.ReactNode;
  notFound?: React.ReactNode;
}) {
  const framed = (node: React.ReactNode) => (Frame ? <Frame>{node}</Frame> : node);
  if (query.isPending) return framed(<LoadingState className={loadingClassName} />);
  if (query.isLoadingError && notFound !== undefined && isNotFound(query.error)) return notFound;
  if (query.isLoadingError)
    return framed(
      error ? (
        error(query.error)
      ) : (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ),
    );
  const data = query.data as T;
  return empty !== undefined && isEmpty(data) ? empty : children(data);
}

/**
 * Several queries as one for QueryView: failed when one of them failed to load (retrying refetches
 * those), loading while one still loads, then their data as a tuple.
 */
export function combineQueries<const T extends readonly unknown[]>(
  ...queries: { [K in keyof T]: QueryResult<T[K]> }
): QueryResult<T> {
  const all: readonly QueryResult<unknown>[] = queries;
  const failed = all.filter((query) => query.isLoadingError);
  return {
    isPending: failed.length === 0 && all.some((query) => query.isPending),
    isLoadingError: failed.length > 0,
    error: failed[0]?.error,
    data: all.every((query) => query.data !== undefined)
      ? (all.map((query) => query.data) as unknown as T)
      : undefined,
    refetch: () => Promise.all(failed.map((query) => query.refetch())),
  };
}
