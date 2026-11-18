import type { Node } from "@edgeweir/contract";
import { createContext } from "react";

export const NodeWorkspaceContext = createContext<Node | null>(null);
