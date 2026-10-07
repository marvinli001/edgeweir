import * as React from "react";
import { encode } from "uqr";
import { cn } from "@/lib/utils";

/** The code's width when no class sets one, in CSS pixels. */
const TARGET = 184;

/**
 * A QR code drawn as one SVG path at a whole number of pixels per module (crisp at any DPR),
 * black modules on a white quiet zone in both themes (scanners expect dark on light), framed in a
 * well.
 */
export function QrCode({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const { size, path } = React.useMemo(() => {
    // A four-module quiet zone, as the standard asks: the well around it is dark in dark mode.
    const qr = encode(value, { ecc: "M", border: 4 });
    let d = "";
    qr.data.forEach((row, y) => {
      row.forEach((on, x) => {
        if (on) d += `M${x} ${y}h1v1h-1z`;
      });
    });
    return { size: qr.size, path: d };
  }, [value]);
  const pixels = size * Math.max(2, Math.round(TARGET / size));
  return (
    <div className="inline-flex shrink-0 rounded-2xl p-2 sunk-well">
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${size} ${size}`}
        shapeRendering="crispEdges"
        width={pixels}
        height={pixels}
        className={cn("block max-w-full rounded-lg bg-white", className)}
      >
        <title>{label}</title>
        <path d={path} className="fill-black" />
      </svg>
    </div>
  );
}
