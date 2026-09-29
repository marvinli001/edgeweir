import * as React from "react";
import { AuthFrame } from "@/components/auth-shell";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";

/** Longest the outgoing card stays if its exit animation never reports its end. */
const LEAVE_FALLBACK_MS = 600;

type Swap<V> = { leaving: V | null; forward: boolean };

/**
 * Auth cards that take turns in one place (sign-in → authenticator code → backup code). On a
 * switch the outgoing card stays mounted (inert, fields as typed) and sinks back towards one side
 * while the incoming card comes forward from the other, so the two read as distinct cards
 * exchanging places; the order of `views` sets the direction. The height follows the incoming
 * card, so the centered shell glides instead of jumping, and focus moves to the incoming card's
 * first empty field (or its title). With reduced motion the cards swap instantly.
 */
export function AuthViews<V extends string>({
  views,
  view,
  children,
}: {
  views: readonly V[];
  view: V;
  children: (view: V) => React.ReactNode;
}) {
  const reduced = useReducedMotion();
  const [shown, setShown] = React.useState(view);
  const [swap, setSwap] = React.useState<Swap<V> | null>(null);
  if (view !== shown) {
    // The previous view is state, so the outgoing card keeps its place in the tree (no remount).
    setShown(view);
    setSwap({
      leaving: reduced ? null : shown,
      forward: views.indexOf(view) > views.indexOf(shown),
    });
  }
  const leaving = swap?.leaving ?? null;
  const forward = swap?.forward ?? true;
  const settle = React.useCallback(() => setSwap((s) => s && { ...s, leaving: null }), []);

  React.useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(settle, LEAVE_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [leaving, settle]);

  const [height, setHeight] = React.useState<number>();
  const measure = React.useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const frame = React.useRef<HTMLDivElement>(null);
  const focusedView = React.useRef(view);
  React.useEffect(() => {
    if (focusedView.current === view) return;
    focusedView.current = view;
    const card = frame.current?.querySelector<HTMLElement>('[data-card="current"]');
    if (!card) return;
    const fields = [
      ...card.querySelectorAll<HTMLInputElement>("input:not([type=hidden]):not(:disabled)"),
    ];
    const title = card.querySelector<HTMLElement>('[data-slot="card-title"]');
    const target = fields.find((field) => !field.value) ?? fields[0] ?? title;
    if (target && target === title) target.tabIndex = -1;
    target?.focus({ preventScroll: true });
  }, [view]);

  return (
    <div
      ref={frame}
      className="grid transition-[height] duration-300 ease-out motion-reduce:transition-none"
      style={{ height }}
    >
      {views
        .filter((v) => v === view || v === leaving)
        .map((v) => {
          const current = v === view;
          return (
            <div
              key={v}
              ref={current ? measure : undefined}
              data-card={current ? "current" : "leaving"}
              inert={!current}
              className={cn(
                "col-start-1 row-start-1 self-start",
                current
                  ? swap &&
                      cn(
                        "z-10 animate-card-in",
                        forward ? "slide-in-from-right-16" : "slide-in-from-left-16",
                      )
                  : cn(
                      "pointer-events-none animate-card-out",
                      forward ? "slide-out-to-left-16" : "slide-out-to-right-16",
                    ),
              )}
              onAnimationEnd={
                current
                  ? undefined
                  : (event) => {
                      if (event.target === event.currentTarget) settle();
                    }
              }
            >
              <AuthFrame>{children(v)}</AuthFrame>
            </div>
          );
        })}
    </div>
  );
}
