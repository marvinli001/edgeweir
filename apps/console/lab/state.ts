/**
 * The lab's data state, for three-state QA of every page:
 *
 *   full     fixture data (default)
 *   empty    every procedure answers its schema-derived empty value (lists without items,
 *            singletons with minimal valid values), so pages show their empty states
 *   error    every procedure fails with a 500, which pages show as ErrorState
 *   loading  every procedure stays pending, which pages show as LoadingState / TopProgress
 *
 * The shell (system status, the signed-in account) answers in every state. Chosen in the lab
 * panel (kept in localStorage `edgeweir-lab:state`) or for one page load with `?labState=`
 * before the hash (`/?labState=empty#/sites`); shots.ts takes `--state`.
 */
export const LAB_STATES = ["full", "empty", "error", "loading"] as const;

export type LabState = (typeof LAB_STATES)[number];

export const STATE_KEY = "edgeweir-lab:state";

/** Procedures the console shell needs to render at all; they answer in every state. */
export const SHELL_PROCEDURES: ReadonlySet<string> = new Set(["system.status", "account.me"]);

const isLabState = (value: unknown): value is LabState =>
  typeof value === "string" && (LAB_STATES as readonly string[]).includes(value);

function stored(): LabState {
  try {
    const value = localStorage.getItem(STATE_KEY);
    return isLabState(value) ? value : "full";
  } catch {
    return "full";
  }
}

function fromUrl(): LabState | undefined {
  const value = new URLSearchParams(window.location.search).get("labState");
  return isLabState(value) ? value : undefined;
}

// Read on first use: shots.ts imports this module in Node.
let current: LabState | undefined;

export const labState = (): LabState => {
  current ??= fromUrl() ?? stored();
  return current;
};

/** Switches the state from now on and keeps it; a `?labState=` in the address is dropped. */
export function setLabState(next: LabState) {
  current = next;
  try {
    localStorage.setItem(STATE_KEY, next);
  } catch {
    // Storage blocked: the state lasts until reload.
  }
  if (fromUrl()) {
    const url = new URL(window.location.href);
    url.searchParams.delete("labState");
    window.history.replaceState(window.history.state, "", url);
  }
}
