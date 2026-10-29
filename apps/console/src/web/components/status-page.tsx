import {
  ArrowLeft01Icon,
  Cancel01Icon,
  ComputerIcon,
  File01Icon,
  RefreshIcon,
  Tick02Icon,
  UserIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMatches, useRouter } from "@tanstack/react-router";
import * as React from "react";
import { Button } from "@/components/arc/button/button";
import { CopyButton } from "@/components/copy-button";
import { LinkButton } from "@/components/link-button";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { formatDateTime, m } from "@/lib/i18n";
import { errorMessage } from "@/lib/orpc";
import { cn } from "@/lib/utils";

/**
 * Status pages: a page that does not exist, a request the console refused, a page that failed
 * and a console that cannot be reached. The same card as the edge nodes' built-in error pages
 * (notes/edgeweir-node.md): the status and a short stamp, the title, what to do, the hops of the
 * request (you, the console, the page) with the one that failed marked, the facts for a report
 * and the way on.
 */
export type StatusKind = "not-found" | "forbidden" | "error" | "unreachable";

/** The hop that failed: 1 the console, 2 the page. */
const FAILED_AT: Record<StatusKind, 1 | 2> = {
  "not-found": 2,
  forbidden: 1,
  error: 2,
  unreachable: 1,
};

const TITLES: Record<StatusKind, () => string> = {
  "not-found": m.status_not_found_title,
  forbidden: m.status_forbidden_title,
  error: m.status_error_title,
  unreachable: m.status_unreachable_title,
};

const STAMPS: Record<StatusKind, () => string> = {
  "not-found": m.status_stamp_not_found,
  forbidden: m.status_stamp_forbidden,
  error: m.status_stamp_error,
  unreachable: m.status_stamp_unreachable,
};

const HINTS: Record<StatusKind, () => string> = {
  "not-found": m.status_not_found_hint,
  forbidden: m.status_forbidden_hint,
  error: m.status_error_hint,
  unreachable: m.status_unreachable_hint,
};

const HOP_ICONS = [UserIcon, ComputerIcon, File01Icon];

/** The status shown for an error: the response's, else 000 for no response at all. */
function statusCode(kind: StatusKind, error: unknown): string {
  const status = httpStatus(error);
  if (kind === "not-found") return "404";
  if (kind === "forbidden") return "403";
  if (status !== undefined && status >= 500) return String(status);
  return kind === "unreachable" ? "000" : "500";
}

function httpStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}

/** A failed request that never got an answer (offline, refused, a dropped connection). */
function isNetworkError(error: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  return (
    error instanceof TypeError &&
    /failed to fetch|networkerror|load failed|network request failed/i.test(error.message)
  );
}

/** Which status page an error that reached a route's error boundary gets. */
function statusKindOf(error: unknown): StatusKind {
  const status = httpStatus(error);
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 502 || status === 503 || status === 504) return "unreachable";
  if (status === undefined && isNetworkError(error)) return "unreachable";
  return "error";
}

/** One fact for a report: a label beside a monospace value. */
interface StatusFact {
  label: string;
  value: string;
  copy?: boolean;
}

/** You, the console and the page, joined by the request; the hop that failed is marked. */
function HopTrace({ at, stamp }: { at: 1 | 2; stamp: string }) {
  const hops = [m.status_hop_you(), m.status_hop_console(), m.status_hop_page()];
  return (
    <ol className="mt-7 grid grid-cols-3 text-center" data-testid="status-hops">
      {hops.map((hop, index) => {
        const state = index < at ? "ok" : index === at ? "failed" : "unreached";
        return (
          <li key={hop} className="relative grid min-w-0 justify-items-center" data-state={state}>
            {index < hops.length - 1 ? (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute top-4 right-[calc(-50%+1.25rem)] left-[calc(50%+1.25rem)] -translate-y-1/2",
                  index < at ? "h-0.5 rounded-full bg-primary" : "border-t-2 border-dashed",
                )}
              />
            ) : null}
            <span
              className={cn(
                "relative grid size-8 place-items-center rounded-full",
                state === "ok" && "bg-primary/12 text-primary",
                state === "failed" && "bg-destructive/12 text-destructive",
                state === "unreached" && "bg-well text-muted-foreground",
              )}
            >
              <HugeiconsIcon
                icon={HOP_ICONS[index] ?? File01Icon}
                strokeWidth={2}
                className="size-4"
              />
              {state === "unreached" ? null : (
                <span
                  className={cn(
                    "absolute -right-0.5 -bottom-0.5 grid size-3 place-items-center rounded-full text-primary-foreground ring-2 ring-card",
                    state === "ok"
                      ? "bg-success"
                      : "bg-destructive animate-in fade-in fill-mode-both [animation-delay:350ms]",
                  )}
                >
                  <HugeiconsIcon
                    icon={state === "ok" ? Tick02Icon : Cancel01Icon}
                    strokeWidth={3}
                    className="size-2"
                  />
                </span>
              )}
            </span>
            <span className="mt-2 text-dense text-balance">{hop}</span>
            <span
              className={cn(
                "text-xs",
                state === "failed" ? "font-medium text-destructive" : "text-muted-foreground",
              )}
            >
              {state === "ok" ? m.status_hop_ok() : state === "failed" ? stamp : "—"}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The card itself. `surface` sets where it sits: the whole window (`screen`, with the brand row
 * and its own theme toggle), the console's content area (`shell`), or a page's content (`inline`).
 */
function StatusPage({
  kind,
  code,
  facts,
  actions,
  surface,
  title = TITLES[kind](),
  hint = HINTS[kind](),
}: {
  kind: StatusKind;
  code: string;
  facts: StatusFact[];
  actions: React.ReactNode;
  surface: "screen" | "shell" | "inline";
  title?: string;
  hint?: string;
}) {
  // Inside a page the page header holds the h1.
  const Heading = surface === "inline" ? "h2" : "h1";
  const titleId = `status-title-${React.useId().replace(/[^\w-]/g, "")}`;
  const stamp = STAMPS[kind]();
  const card = (
    <div
      className={cn(
        "flex w-full flex-1 flex-col items-center justify-center p-6 max-[30rem]:p-4",
        surface === "screen" && "min-h-svh bg-background",
        surface === "inline" && "min-h-[min(32rem,70svh)]",
      )}
      data-testid="status-page"
      data-kind={kind}
    >
      {surface === "screen" ? (
        <div className="mb-6 flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-md bg-primary">
            <Logo className="size-5 text-primary-foreground" />
          </span>
          <span className="text-section font-medium">{m.app_name()}</span>
        </div>
      ) : null}
      <section
        className="w-full max-w-140 animate-enter rounded-xl bg-card p-10 shadow-elev-3 max-sm:p-6 dark:border dark:shadow-none"
        aria-labelledby={titleId}
      >
        <div className="flex items-center gap-3 max-[30rem]:flex-col max-[30rem]:items-start max-[30rem]:gap-2">
          <p
            className="text-[2.5rem] leading-none font-medium tabular-nums"
            data-testid="status-code"
          >
            {code}
          </p>
          <span className="rounded-sm bg-destructive/8 px-2 py-0.5 text-xs text-destructive">
            {stamp}
          </span>
        </div>
        <Heading id={titleId} className="mt-4 text-xl leading-7 font-medium text-balance">
          {title}
        </Heading>
        <p className="mt-2 max-w-[34em] text-sm leading-[1.375rem] text-muted-foreground">{hint}</p>
        <HopTrace at={FAILED_AT[kind]} stamp={stamp} />
        <dl className="mt-7 grid gap-2 rounded-lg bg-well p-4">
          {facts.map((fact) => (
            <div
              key={fact.label}
              className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-3"
            >
              <dt className="text-xs leading-5 text-muted-foreground">{fact.label}</dt>
              <dd className="flex min-w-0 items-start justify-between gap-2">
                <span className="line-clamp-3 font-mono text-dense leading-5 [overflow-wrap:anywhere] select-all">
                  {fact.value}
                </span>
                {fact.copy ? <CopyButton value={fact.value} iconOnly /> : null}
              </dd>
            </div>
          ))}
        </dl>
        <div className="mt-6 flex flex-wrap gap-2">{actions}</div>
      </section>
    </div>
  );
  if (surface === "screen") {
    return (
      <>
        <ThemeToggle className="fixed top-4 right-4 z-10 md:top-6 md:right-6" />
        {card}
      </>
    );
  }
  return card;
}

function OverviewButton({ variant }: { variant?: "secondary" }) {
  return (
    <LinkButton variant={variant} to="/overview">
      {m.status_back_overview()}
    </LinkButton>
  );
}

function BackButton() {
  return (
    <Button variant="secondary" onClick={() => window.history.back()}>
      <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} data-icon="inline-start" />
      {m.status_back()}
    </Button>
  );
}

/** When the page was shown, as a fact for reports. */
function useShownAt(): string {
  const [at] = React.useState(() => new Date().toISOString());
  return formatDateTime(at);
}

/** The list a missing record belongs to: the page says what is missing and leads back there. */
export interface MissingRecord {
  title: string;
  to: "/sites" | "/l4";
  label: string;
}

/**
 * A path no page serves, or a record that no longer exists (`record`: a deleted site's old link
 * leads back to the sites list); the requested path is shown.
 */
export function NotFoundPage({
  path,
  surface,
  record,
}: {
  path: string;
  surface: "screen" | "shell" | "inline";
  record?: MissingRecord;
}) {
  const shownAt = useShownAt();
  return (
    <StatusPage
      kind="not-found"
      code="404"
      surface={surface}
      title={record?.title}
      hint={record ? m.status_record_hint() : undefined}
      facts={[
        { label: m.status_path(), value: path },
        { label: m.status_time(), value: shownAt },
      ]}
      actions={
        <>
          {record ? <LinkButton to={record.to}>{record.label}</LinkButton> : <OverviewButton />}
          <BackButton />
        </>
      }
    />
  );
}

/**
 * The router's error boundary: the status page for the error, inside the console when the
 * console itself loaded, else on its own. Retrying re-runs the failed route's checks and loaders.
 */
export function RouteErrorPage({ error }: { error: unknown }) {
  const router = useRouter();
  const inConsole = useMatches({
    select: (matches) =>
      matches.some((match) => match.routeId === "/_app" && match.status === "success"),
  });
  const shownAt = useShownAt();
  const kind = statusKindOf(error);
  const path = router.state.location.href;
  const retry = (
    <Button onClick={() => void router.invalidate()}>
      <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} data-icon="inline-start" />
      {m.common_retry()}
    </Button>
  );
  const detail: StatusFact =
    kind === "unreachable"
      ? { label: m.status_address(), value: window.location.origin }
      : kind === "error"
        ? {
            label: m.status_error(),
            value: errorMessage(error, m.common_unknown_error()),
            copy: true,
          }
        : { label: m.status_path(), value: path };
  return (
    <StatusPage
      kind={kind}
      code={statusCode(kind, error)}
      surface={inConsole ? "shell" : "screen"}
      facts={[detail, { label: m.status_time(), value: shownAt }]}
      actions={
        kind === "unreachable" ? (
          retry
        ) : kind === "error" ? (
          <>
            {retry}
            {inConsole ? <OverviewButton variant="secondary" /> : null}
          </>
        ) : (
          <>
            <OverviewButton />
            <BackButton />
          </>
        )
      }
    />
  );
}
