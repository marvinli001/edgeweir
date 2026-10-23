import { describe, expect, it } from "vitest";
import { formatPorts, parsePorts } from "../../src/web/lib/ports";

describe("connection limit port lists", () => {
  it("reads ports and ranges separated by commas or spaces", () => {
    expect(parsePorts("80, 443 10000-10999,")).toEqual([
      { start: 80, end: 80 },
      { start: 443, end: 443 },
      { start: 10000, end: 10999 },
    ]);
    expect(parsePorts("")).toEqual([]);
  });

  it("refuses anything that is not a port or range", () => {
    for (const bad of ["0", "65536", "443-80", "http", "80-", "1-2-3", "-1"])
      expect(parsePorts(bad), bad).toBeNull();
  });

  it("writes ranges back as they are read", () => {
    const ranges = [
      { start: 80, end: 80 },
      { start: 8000, end: 8443 },
    ];
    expect(formatPorts(ranges)).toBe("80, 8000-8443");
    expect(parsePorts(formatPorts(ranges))).toEqual(ranges);
  });
});
