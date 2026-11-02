import { MCP_SCOPE_WRITE, mcpProcedureAllowed } from "@edgeweir/contract";
import { createMcpHandler, McpServer, type McpServerFactory } from "@modelcontextprotocol/server";
import { call, isProcedure, ORPCError } from "@orpc/server";
import * as z from "zod";
import type { OAuthPrincipal } from "../services/mcp";
import { type RequestContext, readOnlyAllowed } from "./base";
import { router } from "./router";

/**
 * The MCP server of /mcp (ADR-0076): contract-driven progressive discovery
 * (search_operations, describe_operation, call_operation) plus a few common
 * tools. Every call runs the procedure in process through the oRPC router, so
 * the guards of rpc/base.ts, input validation, optimistic concurrency and the
 * audit log apply as they do on /rpc and /api/v1. Stateless: one server
 * instance per HTTP request.
 */

/** A tool result longer than this is cut, with a note to narrow the query or page. */
const MCP_RESULT_MAX_CHARS = 50_000;

interface Operation {
  /** Dotted procedure path, e.g. "sites.list". */
  name: string;
  method: string;
  /** Its /api/v1 path. */
  path: string;
  group: string;
  readOnly: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: oRPC's procedure type, called through `call`.
  procedure: any;
}

function collectOperations(node: unknown, prefix: string[], into: Operation[]) {
  if (isProcedure(node)) {
    const route = node["~orpc"].route;
    const method = route.method ?? "POST";
    const name = prefix.join(".");
    if (mcpProcedureAllowed(name))
      into.push({
        name,
        method,
        path: route.path ?? "",
        group: prefix[0] ?? "",
        readOnly: readOnlyAllowed(method, prefix),
        procedure: node,
      });
    return;
  }
  if (node && typeof node === "object")
    for (const [key, child] of Object.entries(node))
      collectOperations(child, [...prefix, key], into);
}

/** Every procedure MCP clients may call, in router order. */
const operations: readonly Operation[] = (() => {
  const all: Operation[] = [];
  collectOperations(router, [], all);
  return all;
})();
const operationsByName = new Map(operations.map((op) => [op.name, op]));

/** JSON Schema of a procedure's input or output (null: it has none). */
function jsonSchema(schema: unknown, io: "input" | "output"): unknown {
  if (!(schema instanceof z.ZodType)) return null;
  try {
    return z.toJSONSchema(schema, { io, unrepresentable: "any" });
  } catch {
    return {};
  }
}

/** Common tasks as tools of their own, with their procedure's input schema. */
const FIXED_TOOLS: readonly [
  tool: string,
  title: string,
  description: string,
  operation: string,
][] = [
  [
    "get_overview",
    "Overview",
    "Sites, nodes, recent changes and what needs attention.",
    "overview.get",
  ],
  [
    "list_sites",
    "List sites",
    "Sites, filtered by name, domain or tag, one page at a time.",
    "sites.list",
  ],
  [
    "purge_cache",
    "Purge cache",
    "Purges cached URLs, prefixes, hosts, tags or whole sites; returns the cache task.",
    "cacheTasks.create",
  ],
  [
    "query_access_logs",
    "Query access logs",
    "Sampled access log entries of a site in a time window (from / to, ISO 8601).",
    "logs.query",
  ],
  [
    "get_site_stats",
    "Traffic statistics",
    "Requests, bandwidth and status codes of every site or one, over a range.",
    "analytics.traffic",
  ],
  ["list_alerts", "Alerts", "Recent alert events (firing and resolved).", "alerts.events"],
];
const fixedToolOperations = new Map(FIXED_TOOLS.map(([tool, , , name]) => [tool, name]));

/**
 * The scope a tools/call needs beyond reading (null: none): /mcp answers 403 insufficient_scope
 * before the call when the token lacks it, so the client can ask for it.
 */
export function toolCallScope(tool: string, args: unknown): string | null {
  const name =
    tool === "call_operation"
      ? (args as { name?: unknown } | null)?.name
      : fixedToolOperations.get(tool);
  const op = typeof name === "string" ? operationsByName.get(name) : undefined;
  return op && !op.readOnly ? MCP_SCOPE_WRITE : null;
}

function text(value: unknown, isError = false) {
  let body = typeof value === "string" ? value : JSON.stringify(value);
  if (body.length > MCP_RESULT_MAX_CHARS)
    body = `${body.slice(0, MCP_RESULT_MAX_CHARS)}\n[truncated: showed ${MCP_RESULT_MAX_CHARS} of ${body.length} characters; narrow the query or request a smaller page (page, pageSize, limit, cursor)]`;
  return { content: [{ type: "text" as const, text: body }], ...(isError ? { isError } : {}) };
}

/** Per-request inputs of the server, handed over in AuthInfo.extra. */
interface McpCaller {
  principal: OAuthPrincipal;
  context: RequestContext;
}

async function runOperation(caller: McpCaller, op: Operation, input: unknown) {
  try {
    const result = await call(op.procedure, input, {
      context: { ...caller.context, oauth: caller.principal },
      path: op.name.split("."),
    });
    return text(result ?? { ok: true });
  } catch (error) {
    if (error instanceof ORPCError)
      return text({ error: error.code, message: error.message, data: error.data }, true);
    throw error;
  }
}

/** Annotations of a fixed procedure, by its method. */
function annotationsOf(op: Operation) {
  return {
    readOnlyHint: op.readOnly,
    destructiveHint: op.method === "DELETE" || op.method === "PUT",
    idempotentHint: op.method !== "POST",
    openWorldHint: false,
  };
}

const INSTRUCTIONS = `Edgeweir console: a self-hosted CDN / WAF control plane (sites, rules, certificates, cache purges, access logs, statistics, alerts, clusters and nodes).
Find operations with search_operations (no arguments lists the groups), read their input schema with describe_operation, then run them with call_operation. Inputs are the procedure inputs as JSON. Changes need the edgeweir:write scope and are recorded in the audit log.`;

/** The tools of one request's server. */
function buildServer(caller: McpCaller, version: string): McpServer {
  const server = new McpServer(
    { name: "edgeweir", version },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "search_operations",
    {
      title: "Search operations",
      description:
        "Lists console operations whose name, path or group contains every keyword. Without query and group it lists the groups. Each result says whether the operation only reads.",
      inputSchema: z.object({
        query: z.string().max(200).optional().describe("Keywords, e.g. 'site purge' or 'logs'"),
        group: z.string().max(64).optional().describe("Only this group, e.g. 'sites'"),
        limit: z.number().int().min(1).max(200).optional().describe("At most this many (50)"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, group, limit }) => {
      const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length && !group) {
        const groups = new Map<string, number>();
        for (const op of operations) groups.set(op.group, (groups.get(op.group) ?? 0) + 1);
        return text({ groups: [...groups].map(([name, count]) => ({ name, operations: count })) });
      }
      const found = operations.filter((op) => {
        if (group && op.group !== group) return false;
        const haystack = `${op.name} ${op.method} ${op.path}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
      });
      return text({
        total: found.length,
        operations: found.slice(0, limit ?? 50).map(({ name, method, path, readOnly }) => ({
          name,
          method,
          path,
          readOnly,
        })),
      });
    },
  );

  server.registerTool(
    "describe_operation",
    {
      title: "Describe an operation",
      description: "The JSON Schema of an operation's input and output.",
      inputSchema: z.object({ name: z.string().max(200).describe("e.g. 'sites.list'") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ name }) => {
      const op = operationsByName.get(name);
      if (!op) return text({ error: "UNKNOWN_OPERATION", message: `no operation ${name}` }, true);
      const orpc = op.procedure["~orpc"];
      return text({
        name: op.name,
        method: op.method,
        path: op.path,
        readOnly: op.readOnly,
        input: jsonSchema(orpc.inputSchema, "input"),
        output: jsonSchema(orpc.outputSchema, "output"),
      });
    },
  );

  server.registerTool(
    "call_operation",
    {
      title: "Call an operation",
      description:
        "Runs a console operation with its input (see describe_operation). Operations that are not read-only change the console and need the edgeweir:write scope.",
      inputSchema: z.object({
        name: z.string().max(200).describe("e.g. 'sites.list'"),
        input: z.record(z.string(), z.unknown()).optional().describe("The operation's input"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ name, input }) => {
      const op = operationsByName.get(name);
      if (!op) return text({ error: "UNKNOWN_OPERATION", message: `no operation ${name}` }, true);
      return runOperation(caller, op, input);
    },
  );

  for (const [tool, title, description, name] of FIXED_TOOLS) {
    const op = operationsByName.get(name);
    if (!op) continue;
    const input = op.procedure["~orpc"].inputSchema;
    server.registerTool(
      tool,
      {
        title,
        description,
        ...(input instanceof z.ZodObject ? { inputSchema: input } : {}),
        annotations: annotationsOf(op),
      },
      // biome-ignore lint/suspicious/noExplicitAny: the input is the procedure's own schema.
      (async (args: any) => runOperation(caller, op, input ? args : undefined)) as never,
    );
  }
  return server;
}

/**
 * The /mcp request handler. Serves MCP 2026-07-28 (per-request) and, statelessly, 2025-era
 * clients; JSON responses only (no streams to hold open).
 */
export function createMcpServerHandler(opts: {
  version: string;
  maxRequestBodySize: number;
  onerror: (error: Error) => void;
}) {
  const factory: McpServerFactory = ({ authInfo }) => {
    const caller = authInfo?.extra?.caller as McpCaller | undefined;
    if (!caller) throw new Error("MCP request without a caller");
    return buildServer(caller, opts.version);
  };
  return createMcpHandler(factory, {
    legacy: "stateless",
    responseMode: "json",
    maxRequestBodySize: opts.maxRequestBodySize,
    onerror: opts.onerror,
  });
}
