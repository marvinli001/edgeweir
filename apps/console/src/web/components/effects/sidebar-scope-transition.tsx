import * as React from "react";
import { motionTokens } from "@/components/arc/motion-tokens";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { scopeDirection } from "@/lib/workspace-nav";
import { AnimatePresence, motion, useIsPresent, usePresenceData } from "./motion";

interface Transition {
  direction: ReturnType<typeof scopeDirection>;
  skip: boolean;
}

function ScopeLayer({
  enter,
  onEntered,
  children,
}: {
  enter: Transition;
  onEntered: () => void;
  children: React.ReactNode;
}) {
  const present = useIsPresent();
  const leave = usePresenceData() as Transition;
  const reduced = useReducedMotion();
  return (
    <motion.div
      data-slot="sidebar-scope-layer"
      className="col-start-1 row-start-1 flex min-h-0 min-w-0 flex-col overflow-hidden"
      inert={!present || undefined}
      aria-hidden={!present || undefined}
      style={{ pointerEvents: present ? undefined : "none" }}
      initial={enter.skip ? false : { opacity: 0, ...(!reduced && { x: enter.direction * 8 }) }}
      animate={{
        opacity: 1,
        ...(!reduced && { x: 0 }),
        transition: {
          duration: reduced ? 0.12 : 0.24,
          ease: [...motionTokens.ease.enter],
        },
      }}
      exit={{
        opacity: 0,
        ...(!reduced && !leave.skip && { x: -leave.direction * 8 }),
        transition: {
          duration: leave.skip ? 0 : reduced ? 0.12 : 0.16,
          ease: [...motionTokens.ease.exit],
        },
      }}
      onAnimationComplete={present ? onEntered : undefined}
    >
      {children}
    </motion.div>
  );
}

export function SidebarScopeTransition({
  kind,
  children,
}: {
  kind?: string;
  children: React.ReactNode;
}) {
  const root = React.useRef<HTMLDivElement>(null);
  const focus = React.useRef<Element | null>(null);
  const previous = React.useRef({ kind, direction: scopeDirection(kind, kind) });
  const ready = React.useRef(false);
  React.useEffect(() => {
    const frame = requestAnimationFrame(() => {
      ready.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  if (previous.current.kind !== kind) {
    const active = document.activeElement;
    focus.current = root.current?.contains(active) ? active : null;
    previous.current = { kind, direction: scopeDirection(previous.current.kind, kind) };
  }
  const transition = { direction: previous.current.direction, skip: !ready.current };
  return (
    <div
      ref={root}
      className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)] overflow-hidden"
    >
      <AnimatePresence initial={false} custom={transition}>
        <ScopeLayer
          key={kind ?? ""}
          enter={transition}
          onEntered={() => {
            const source = focus.current;
            focus.current = null;
            const active = document.activeElement;
            if (source && (active === source || active === document.body)) {
              root.current
                ?.querySelector<HTMLElement>(
                  '[data-slot="sidebar-scope-layer"]:not([inert]) :is([aria-current="page"], [data-current])',
                )
                ?.focus();
            }
          }}
        >
          {children}
        </ScopeLayer>
      </AnimatePresence>
    </div>
  );
}
