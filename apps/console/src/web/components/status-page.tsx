import { ArrowLeft01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useMatches, useRouter } from "@tanstack/react-router";
import * as React from "react";
import { CopyButton } from "@/components/copy-button";
import { SiteHeader } from "@/components/site-header";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { formatDateTime, m } from "@/lib/i18n";
import { errorMessage } from "@/lib/orpc";
import { cn } from "@/lib/utils";

/**
 * Status pages: a page that does not exist, a request the console refused, a page that failed
 * and a console that cannot be reached. Each reads one request like an instrument, the same
 * design as the edge nodes' built-in error pages: a signal runs from the operator through the
 * console to the page and stops, thins out or breaks at the hop that failed, under the status
 * set large. Styles: `.status-*` in index.css.
 */
export type StatusKind = "not-found" | "forbidden" | "error" | "unreachable";

type Signal = "flow" | "slow" | "held" | "fade" | "noise";
type Mark = "stop" | "cross" | "clock" | "void";

/** The failing hop (1 the console, 2 the page), the signal on each side of the console. */
interface Shape {
  at: 1 | 2;
  a: Signal;
  b: Signal;
  mark: Mark;
  weight: number;
  decay?: boolean;
}

const SHAPES: Record<StatusKind, Shape> = {
  "not-found": { at: 2, a: "flow", b: "fade", mark: "void", weight: 250 },
  forbidden: { at: 1, a: "flow", b: "held", mark: "stop", weight: 760 },
  error: { at: 2, a: "flow", b: "noise", mark: "cross", weight: 700 },
  unreachable: { at: 1, a: "slow", b: "held", mark: "clock", weight: 200, decay: true },
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

/** Edgeweir's wave, one period every 24px, long enough for a third of the widest frame, twice. */
const WAVE = `M-24 30.5${"c6 0 6-5 12-5s6 5 12 5".repeat(34)}`;
const NOISE =
  "M0 28L6 37 10 18 16 39 24 21 30 36 34 16 40 41 44 17 50 35 58 19 64 40 70 22 74 35 82 17 86 39 92 20 98 37 106 18 110 41 116 24 120 36 126 16 134 38 140 22 146 41 152 18 156 35 162 21 170 38 176 17 180 40 186 23 192 36 200 19 206 37 210 16 216 39 224 22 230 35";

/** Inside a hop's mark: the console's own mark (Edgeweir's crest over the wave) or the failure. */
const GLYPHS = {
  logo: "M-4.5 0l4.5-4.5 4.5 4.5M-5.5 4c1.4 0 1.4-1.3 2.75-1.3s1.4 1.3 2.75 1.3 1.4-1.3 2.75-1.3 1.4 1.3 2.75 1.3",
  stop: "M-4.6-4.6l9.2 9.2",
  cross: "M-2.6-2.6l5.2 5.2M2.6-2.6l-5.2 5.2",
  clock: "M0-3.5V0l2.5 1.8",
  void: "",
} as const;

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
export function statusKindOf(error: unknown): StatusKind {
  const status = httpStatus(error);
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 502 || status === 503 || status === 504) return "unreachable";
  if (status === undefined && isNetworkError(error)) return "unreachable";
  return "error";
}

function Signal({ kind, side, wave }: { kind: Signal; side: "a" | "b"; wave: string }) {
  const line = (
    <svg aria-hidden="true">
      <use href={`#${wave}`} className="status-wave" />
    </svg>
  );
  if (kind === "held") {
    return (
      <span className="status-seg" data-side={side} data-kind="held">
        <svg aria-hidden="true">
          <line x1="0" y1="28" x2="100%" y2="28" />
        </svg>
      </span>
    );
  }
  if (kind === "noise") {
    return (
      <>
        <span className="status-seg" data-side={side} data-kind="out">
          {line}
        </span>
        <span className="status-seg" data-side={side} data-kind="noise">
          <svg aria-hidden="true">
            <path d={NOISE} />
          </svg>
        </span>
      </>
    );
  }
  return (
    <span className="status-seg" data-side={side} data-kind={kind}>
      {line}
    </span>
  );
}

function Marks({ shape }: { shape: Shape }) {
  const failing = (hop: 1 | 2) => (shape.at === hop ? true : undefined);
  return (
    <svg aria-hidden="true" className="status-marks">
      <svg aria-hidden="true" x="16.667%" y="28" overflow="visible">
        <circle r="9.5" data-mark="ring" />
        <circle r="3.5" className="fill-foreground" />
      </svg>
      <svg aria-hidden="true" x="50%" y="28" overflow="visible" data-failing={failing(1)}>
        <g>
          <circle r="11" data-mark="shape" />
          <path d={shape.at === 1 ? GLYPHS[shape.mark] : GLYPHS.logo} data-mark="glyph" />
        </g>
      </svg>
      <svg aria-hidden="true" x="83.333%" y="28" overflow="visible" data-failing={failing(2)}>
        <g>
          <rect
            x="-7"
            y="-7"
            width="14"
            height="14"
            rx="3"
            data-mark={shape.mark === "void" ? "void" : "shape"}
          />
          {shape.at === 2 && shape.mark !== "void" ? (
            <path d={GLYPHS[shape.mark]} data-mark="glyph" />
          ) : null}
        </g>
      </svg>
    </svg>
  );
}

/** One fact under the instrument: a label over a monospace value. */
export interface StatusFact {
  label: string;
  value: string;
  copy?: boolean;
}

/**
 * The instrument itself. `surface` sets where it sits: the whole window (`screen`, with its own
 * theme toggle), the sidebar inset below a bare header (`shell`), or a page's content (`inline`).
 */
export function StatusPage({
  kind,
  code,
  facts,
  actions,
  surface,
}: {
  kind: StatusKind;
  code: string;
  facts: StatusFact[];
  actions: React.ReactNode;
  surface: "screen" | "shell" | "inline";
}) {
  const shape = SHAPES[kind];
  // Inside a page the page header holds the h1.
  const Heading = surface === "inline" ? "h2" : "h1";
  const wave = `status-wave-${React.useId().replace(/[^\w-]/g, "")}`;
  const states = [1, 2, 3].map((hop) =>
    hop - 1 < shape.at
      ? m.status_hop_ok()
      : hop - 1 === shape.at
        ? STAMPS[kind]()
        : m.status_hop_unreached(),
  );
  const hops = [m.status_hop_you(), m.status_hop_console(), m.status_hop_page()];
  const instrument = (
    <div
      className={cn(
        "status-surface",
        surface === "screen" && "min-h-svh bg-background",
        surface === "shell" && "flex-1",
        surface === "inline" && "-mx-4 min-h-[min(36rem,70svh)] lg:-mx-6",
      )}
      data-testid="status-page"
      data-kind={kind}
    >
      <section className="status-frame @container/status" aria-labelledby={`${wave}-title`}>
        <i className="status-detent top-0 left-0" />
        <i className="status-detent top-0 left-full" />
        <i className="status-detent top-full left-0" />
        <i className="status-detent top-full left-full" />
        <div
          className="status-top"
          data-at={shape.at}
          data-decay={shape.decay || undefined}
          style={{ "--status-weight": shape.weight } as React.CSSProperties}
        >
          <i className="status-detent top-full left-0" />
          <i className="status-detent top-full left-full" />
          <p className="status-code" data-testid="status-code">
            {code}
          </p>
          <div className="status-trace" aria-hidden="true">
            <svg aria-hidden="true" className="absolute size-0">
              <path id={wave} d={WAVE} />
            </svg>
            <i className="status-cursor" />
            <i className="status-head" />
            <Signal kind={shape.a} side="a" wave={wave} />
            <Signal kind={shape.b} side="b" wave={wave} />
            <Marks shape={shape} />
          </div>
          <ol className="mt-4.5 grid grid-cols-3 text-center">
            {hops.map((hop, index) => (
              <li
                key={hop}
                className="grid min-w-0 justify-items-center"
                data-state={index < shape.at ? "ok" : index === shape.at ? "failed" : "unreached"}
              >
                <span
                  className={cn(
                    "text-sm font-medium",
                    index > shape.at && "font-normal text-muted-foreground",
                  )}
                >
                  {hop}
                </span>
                <span
                  className={cn(
                    "text-xs text-muted-foreground",
                    index === shape.at && "font-medium text-destructive",
                  )}
                >
                  {states[index]}
                </span>
              </li>
            ))}
          </ol>
        </div>
        <div className="status-bottom grid gap-x-16 gap-y-7 px-1 pt-8.5 pb-9 @2xl/status:grid-cols-[minmax(0,1fr)_minmax(0,16.5rem)] @2xl/status:px-11 @2xl/status:pt-11 @2xl/status:pb-12">
          <div className="min-w-0">
            <Heading
              id={`${wave}-title`}
              className="text-[1.75rem] leading-tight font-semibold tracking-tight text-balance"
            >
              {TITLES[kind]()}
            </Heading>
            <div className="mt-5.5 flex flex-wrap gap-2">{actions}</div>
          </div>
          <dl className="grid content-start gap-3">
            {facts.map((fact) => (
              <div key={fact.label} className="grid gap-0.5 border-t pt-2.5">
                <dt className="text-xs text-muted-foreground">{fact.label}</dt>
                <dd className="flex items-start justify-between gap-2">
                  <span className="line-clamp-3 font-mono text-[0.8125rem] break-all select-all">
                    {fact.value}
                  </span>
                  {fact.copy ? <CopyButton value={fact.value} iconOnly /> : null}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </div>
  );
  if (surface === "screen") {
    return (
      <>
        <ThemeToggle className="fixed top-4 right-4 z-10 md:top-6 md:right-6" />
        {instrument}
      </>
    );
  }
  if (surface === "shell") {
    return (
      <>
        <SiteHeader />
        {instrument}
      </>
    );
  }
  return instrument;
}

function OverviewButton({ variant }: { variant?: "outline" }) {
  return (
    <Button variant={variant} render={<Link to="/overview" />} nativeButton={false}>
      {m.status_back_overview()}
    </Button>
  );
}

function BackButton() {
  return (
    <Button variant="outline" onClick={() => window.history.back()}>
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

/** A path no page serves, or a record that no longer exists (the requested path is shown). */
export function NotFoundPage({
  path,
  surface,
}: {
  path: string;
  surface: "screen" | "shell" | "inline";
}) {
  const shownAt = useShownAt();
  return (
    <StatusPage
      kind="not-found"
      code="404"
      surface={surface}
      facts={[
        { label: m.status_path(), value: path },
        { label: m.status_time(), value: shownAt },
      ]}
      actions={
        <>
          <OverviewButton />
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
            {inConsole ? <OverviewButton variant="outline" /> : null}
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
