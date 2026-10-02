import type { SiteDelivery } from "@edgeweir/contract";
import { type QueryClient, QueryObserver } from "@tanstack/react-query";
import { toast } from "sonner";
import { canaryLabel } from "@/components/site-status";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

/** How long a toast follows a change before it keeps the last state it saw. */
const FOLLOW_MS = 3 * 60_000;
const POLL_MS = 3000;
/** How long a settled toast stays. */
const SETTLED_MS = 6000;

/** Stops following a site (a newer change of the same site replaces it). */
const following = new Map<string, () => void>();

/** Where a change stands on the nodes, and whether there is nothing more to wait for. */
function progress(delivery: SiteDelivery): { text: string; settled: boolean; done: boolean } {
  const { state, totalNodes: total, servingNodes, currentNodes: current } = delivery;
  if (state === "disabled")
    return servingNodes === 0
      ? { text: m.site_delivery_removed(), settled: true, done: true }
      : {
          text: m.site_delivery_removing({ done: total - servingNodes, total }),
          settled: false,
          done: false,
        };
  if (state === "live") return { text: m.site_delivery_live(), settled: true, done: true };
  if (total === 0) return { text: m.site_delivery_no_nodes(), settled: true, done: false };
  // A canary holds the change back until its window ends: nothing to follow until then.
  const canary = canaryLabel(delivery);
  if (canary) return { text: canary, settled: true, done: false };
  return { text: m.site_state_partial({ current, total }), settled: false, done: false };
}

function show(id: string, title: string, delivery: SiteDelivery, final = false) {
  const { text, settled, done } = progress(delivery);
  const options = { id, description: text, testId: "site-delivery-toast" };
  if (done) toast.success(title, { ...options, duration: SETTLED_MS });
  else if (settled || final) toast.info(title, { ...options, duration: SETTLED_MS });
  else toast.loading(title, options);
  return settled;
}

/**
 * One toast for a site change that follows it onto the nodes in place:
 * "Saved · Rolling out 3/5" until "Live on every node" (or a canary's end,
 * or no online node), polling the site for a few minutes at most.
 */
export function followSiteDelivery(
  queryClient: QueryClient,
  siteId: string,
  title: string,
  delivery: SiteDelivery,
) {
  following.get(siteId)?.();
  const id = `site-delivery-${siteId}`;
  if (show(id, title, delivery)) return;
  const started = Date.now();
  let last = delivery;
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (final: boolean) => {
    unsubscribe();
    clearTimeout(timer);
    following.delete(siteId);
    if (final) show(id, title, last, true);
  };
  const observer = new QueryObserver(queryClient, {
    ...orpc.sites.get.queryOptions({ input: { id: siteId } }),
    refetchInterval: POLL_MS,
    meta: { background: true },
  });
  unsubscribe = observer.subscribe((result) => {
    if (result.isError) return stop(true);
    // What the cache held before the change says nothing about it.
    if (!result.data || result.dataUpdatedAt < started) return;
    last = result.data.delivery;
    if (show(id, title, last)) stop(false);
  });
  timer = setTimeout(() => stop(true), FOLLOW_MS);
  following.set(siteId, () => stop(false));
}
