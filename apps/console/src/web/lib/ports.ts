type Range = { start: number; end: number };

/** "80, 443, 10000-10999". */
export function formatPorts(ranges: readonly Range[]): string {
  return ranges.map((r) => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`)).join(", ");
}

/** Ports and ranges separated by commas or spaces, or null when one is not a port. */
export function parsePorts(text: string): Range[] | null {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  const out: Range[] = [];
  for (const part of parts) {
    const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part);
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (start < 1 || end > 65535 || end < start) return null;
    out.push({ start, end });
  }
  return out;
}
