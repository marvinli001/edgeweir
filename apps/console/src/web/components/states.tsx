import { Alert02Icon, type InboxIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { InboxIcon as AnimatedInbox, useIconPlay } from "@/components/effects/animated-icons";
import { LoadingState } from "@/components/loading-state";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { m } from "@/lib/i18n";
import { errorMessage, isNotFound } from "@/lib/orpc";

export { LoadingState };

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <Alert variant="destructive" role="alert">
      <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} />
      <AlertTitle>{m.common_error_title()}</AlertTitle>
      <AlertDescription>{errorMessage(error, m.common_unknown_error())}</AlertDescription>
      {onRetry ? (
        <AlertAction>
          <Button size="sm" variant="outline" onClick={onRetry}>
            {m.common_retry()}
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}

export function EmptyState({
  title,
  icon,
  children,
}: {
  title: string;
  /** Without one, an inbox that settles when the state is hovered. */
  icon?: typeof InboxIcon;
  children?: React.ReactNode;
}) {
  const { ref, trigger } = useIconPlay();
  return (
    <Empty
      className="border border-dashed border-edge bg-linear-to-b from-well/70 to-transparent animate-enter"
      {...trigger}
    >
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {icon ? <HugeiconsIcon icon={icon} strokeWidth={2} /> : <AnimatedInbox ref={ref} />}
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
      </EmptyHeader>
      {children ? <EmptyContent>{children}</EmptyContent> : null}
    </Empty>
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
 * `isLoadingError`. `frame` wraps the loading and error states, e.g. CardContent in a card whose
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
