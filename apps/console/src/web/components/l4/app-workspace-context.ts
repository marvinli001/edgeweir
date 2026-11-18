import type { L4App } from "@edgeweir/contract";
import { createContext } from "react";
import type { L4StatsRange } from "@/lib/l4";

export const L4WorkspaceContext = createContext<{
  app: L4App;
  range: L4StatsRange;
  setRange: (range: L4StatsRange) => void;
  statsHref: string;
} | null>(null);
