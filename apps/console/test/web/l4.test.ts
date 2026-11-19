import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { l4PlotPoints, listChips } from "../../src/web/lib/l4";

const root = resolve(import.meta.dirname, "../..");

/** The `key` expressions of the elements the component `name` in `file` renders. */
function componentKeys(file: string, name: string): string[] {
  const source = readFileSync(resolve(root, file), "utf8");
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} in ${file}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\nfunction ", start + 1);
  const body = source.slice(start, end === -1 ? undefined : end);
  return [...body.matchAll(/\bkey=\{([^}]+)\}/g)].map((match) => match[1] ?? "");
}

describe("L4 IP-list chips", () => {
  // Fixture ids that share their first eight characters.
  const a = "00000000-0000-4000-8000-00000000000a";
  const b = "00000000-0000-4000-8000-00000000000b";

  it("shows the start of the id while the lists load or once a list is gone, with distinct ids", () => {
    expect(listChips([a, b])).toEqual([
      { id: a, name: "00000000" },
      { id: b, name: "00000000" },
    ]);
    expect(listChips([a, b], [{ id: a, name: "office" }])).toEqual([
      { id: a, name: "office" },
      { id: b, name: "00000000" },
    ]);
  });

  it("names the lists in the application's order once they load", () => {
    const lists = [
      { id: a, name: "office" },
      { id: b, name: "scanners" },
    ];
    expect(listChips([b, a], lists)).toEqual([
      { id: b, name: "scanners" },
      { id: a, name: "office" },
    ]);
  });

  it("keys the chips by list id on the overview and in the dialog, never by the shown name", () => {
    // Two chips named "00000000" would share a key, and React would leave one behind.
    expect(componentKeys("src/web/components/l4/app-overview.tsx", "ListNames")).toEqual([
      "chip.id",
    ]);
    expect(componentKeys("src/web/components/l4/app-dialog.tsx", "ListPicker")).toEqual(["listId"]);
  });
});

it("plots settled L4 totals and the highest concurrency of each group", () => {
  const start = Date.parse("2026-10-07T12:00:00Z");
  const points = Array.from({ length: 360 }, (_, i) => ({
    time: new Date(start + i * 60_000).toISOString(),
    connections: 4,
    refused: 1,
    peakConcurrent: 10 + (i % 5),
    bytesReceived: 20,
    bytesSent: 50,
  }));
  const rows = l4PlotPoints({ points, bucketSeconds: 60, to: "2026-10-07T18:00:00Z" });
  expect(rows.at(-1)).toEqual({
    time: "2026-10-07T17:50:00.000Z",
    connections: 20,
    refused: 5,
    peakConcurrent: 14,
    bytesReceived: 100,
    bytesSent: 250,
  });
});
