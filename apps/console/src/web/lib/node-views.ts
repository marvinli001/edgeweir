import {
  Activity01Icon,
  ArrowDown01Icon,
  Audit01Icon,
  DashboardSquare01Icon,
  GlobeIcon,
  Layers01Icon,
  ListViewIcon,
} from "@hugeicons/core-free-icons";
import { m } from "../paraglide/messages.js";
import { viewHref } from "./workspace-nav";

export const NODE_VIEWS = {
  overview: { label: () => m.node_detail_overview(), icon: DashboardSquare01Icon },
  addresses: { label: () => m.node_addresses_title(), icon: GlobeIcon },
  probes: { label: () => m.scope_node_probes(), icon: Activity01Icon },
  cache: { label: () => m.node_cache_title(), icon: Layers01Icon },
  upgrades: { label: () => m.upgrade_title(), icon: ArrowDown01Icon },
  logs: { label: () => m.node_logs_tab(), icon: Audit01Icon },
  "debug-logs": { label: () => m.node_debug_title(), icon: ListViewIcon },
};

export type NodeView = keyof typeof NODE_VIEWS;

export function nodeMainAddress(
  node: Pick<Node, "schedulingAddresses" | "ipAddresses" | "hostname">,
) {
  return (
    [...node.schedulingAddresses].sort(
      (a, b) =>
        a.level - b.level || Number(a.address.includes(":")) - Number(b.address.includes(":")),
    )[0]?.address ??
    node.ipAddresses[0] ??
    node.hostname
  );
}

export function nodeHref(
  id: string,
  view: NodeView = "overview",
  search?: Parameters<typeof viewHref>[3],
) {
  return viewHref("/clusters/nodes", id, view, search);
}

export function legacyNodeHref(searchStr: string) {
  const search = new URLSearchParams(searchStr);
  const id = search.get("node");
  if (!id) return undefined;
  const view = search.get("nodeTab") === "logs" ? "logs" : "overview";
  search.delete("node");
  search.delete("nodeTab");
  const listSearch = search.toString();
  return nodeHref(id, view, listSearch ? { returnTo: `/clusters?${listSearch}` } : undefined);
}

import type { Node } from "@edgeweir/contract";
