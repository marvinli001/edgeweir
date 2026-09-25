import * as React from "react";
import { encode } from "uqr";
import { cn } from "@/lib/utils";

/** A QR code drawn as one SVG path (black modules on white, readable in dark mode too). */
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
    const qr = encode(value, { ecc: "M", border: 2 });
    let d = "";
    qr.data.forEach((row, y) => {
      row.forEach((on, x) => {
        if (on) d += `M${x} ${y}h1v1h-1z`;
      });
    });
    return { size: qr.size, path: d };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className={cn("size-44 rounded-xl bg-white p-1", className)}
    >
      <title>{label}</title>
      <path d={path} fill="#000" />
    </svg>
  );
}
