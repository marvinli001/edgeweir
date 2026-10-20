import { CC_LEVELS, type CcLevel } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { isOnline } from "../lib/node-online";
import type { Executor } from "./revisions";

/** A level event counts as the node's level while it is newer than the node's heartbeat and this old at most. */
const EVENT_WINDOW_MS = 5 * 60_000;

const isLevel = (value: string): value is CcLevel =>
  (CC_LEVELS as readonly string[]).includes(value);

/** Position of a level: `normal` is 0, the highest challenge level is last. -1 for an unknown name. */
export const levelRank = (level: string) => CC_LEVELS.indexOf(level as CcLevel);

/**
 * The highest CC level the site holds on any online, active node of its cluster. A node's level
 * is the one its last heartbeat carried, unless it reported a level change after that heartbeat
 * (an event received later is newer than the heartbeat's state).
 */
export async function siteCcLevel(
  db: Executor,
  site: { id: string; clusterId: string },
  now = Date.now(),
): Promise<CcLevel> {
  const nodes = (
    await db
      .select({
        id: schema.node.id,
        lastSeenAt: schema.node.lastSeenAt,
        securityState: schema.node.securityState,
      })
      .from(schema.node)
      .where(and(eq(schema.node.clusterId, site.clusterId), eq(schema.node.status, "active")))
  ).filter((node) => isOnline(node.lastSeenAt, now));
  if (nodes.length === 0) return "normal";
  const events = await db
    .selectDistinctOn([schema.securityEvent.nodeId], {
      nodeId: schema.securityEvent.nodeId,
      level: schema.securityEvent.level,
      receivedAt: schema.securityEvent.receivedAt,
    })
    .from(schema.securityEvent)
    .where(
      and(
        eq(schema.securityEvent.siteId, site.id),
        sql`${schema.securityEvent.kind} = 'site_level'`,
        inArray(
          schema.securityEvent.nodeId,
          nodes.map((node) => node.id),
        ),
        gt(schema.securityEvent.receivedAt, new Date(now - EVENT_WINDOW_MS)),
      ),
    )
    .orderBy(
      schema.securityEvent.nodeId,
      desc(schema.securityEvent.occurredAt),
      desc(schema.securityEvent.id),
    );
  const byNode = new Map(events.map((event) => [event.nodeId, event]));
  let top: CcLevel = "normal";
  for (const node of nodes) {
    const heartbeat = node.securityState.find((entry) => entry.siteId === site.id)?.level ?? "";
    const event = byNode.get(node.id);
    const level =
      event && node.lastSeenAt && event.receivedAt > node.lastSeenAt ? event.level : heartbeat;
    if (isLevel(level) && levelRank(level) > levelRank(top)) top = level;
  }
  return top;
}
