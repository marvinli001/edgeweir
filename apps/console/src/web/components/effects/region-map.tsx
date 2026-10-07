/*
 * The regions on a map without borders: the land as a dot grid (world-dots.ts, generated with
 * dotted-map from Natural Earth land; THIRD-PARTY-NOTICES.md), an equirectangular projection, and
 * every region placed by the city its code or name mentions (lib/edge-map.ts). Regions without a
 * known city stay off the map. Drawn once: the markers settle in on mount and nothing loops.
 * Decorative: the region list next to it is the text alternative. Lazy-loaded with the regions
 * view (the dot grid is 45 KB).
 */
import { type LatLng, placeOf } from "@/lib/edge-map";
import { cn } from "@/lib/utils";
import { WORLD_DOTS } from "./world-dots";

const [LAT_MIN, LAT_MAX] = WORLD_DOTS.latitudes;
const HEIGHT = WORLD_DOTS.height;
/** dotted-map's grid width: its rows span the latitudes, the columns take the same scale. */
const GRID_WIDTH = Math.round((HEIGHT * 360) / (LAT_MAX - LAT_MIN));
/** Markers closer than this (grid units) share one label. */
const NEAR = 6;

export interface MapRegion {
  id: string;
  name: string;
  code: string;
  nodeGroupCount: number;
}

interface Marker {
  regions: MapRegion[];
  x: number;
  y: number;
}

const project = ([lat, lng]: LatLng) => ({
  x: ((lng + 180) / 360) * GRID_WIDTH,
  y: ((LAT_MAX - lat) / (LAT_MAX - LAT_MIN)) * HEIGHT,
});

function markersOf(regions: MapRegion[]): Marker[] {
  const markers: Marker[] = [];
  for (const region of regions) {
    const place = placeOf(region.code, region.name);
    if (!place) continue;
    const { x, y } = project(place);
    const near = markers.find((m) => Math.hypot(m.x - x, m.y - y) < NEAR);
    if (near) near.regions.push(region);
    else markers.push({ regions: [region], x, y });
  }
  return markers;
}

export default function RegionMap({
  regions,
  className,
}: {
  regions: MapRegion[];
  className?: string;
}) {
  const markers = markersOf(regions);
  const width = WORLD_DOTS.width;
  return (
    <div
      aria-hidden
      className={cn("@container relative w-full", className)}
      style={{ aspectRatio: `${width} / ${HEIGHT}` }}
    >
      <svg aria-hidden viewBox={`0 0 ${width} ${HEIGHT}`} className="absolute inset-0 size-full">
        <path
          d={WORLD_DOTS.path}
          stroke="var(--muted-foreground)"
          strokeOpacity={0.34}
          strokeWidth={0.46}
          strokeLinecap="round"
        />
      </svg>
      {markers.map((marker, index) => {
        const left = (marker.x / width) * 100;
        const used = marker.regions.some((r) => r.nodeGroupCount > 0);
        const position = { left: `${left}%`, top: `${(marker.y / HEIGHT) * 100}%` };
        return (
          <span key={marker.regions[0]?.id}>
            {/* A region with node groups is a filled point, an unused one a ring. */}
            <span
              className={cn(
                "absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-foreground ring-4 ring-wash animate-in @md:size-2.5 fade-in zoom-in-50 fill-mode-both duration-500 ease-out motion-reduce:animate-none",
                used ? "bg-foreground" : "bg-card",
              )}
              style={{ ...position, animationDelay: `${200 + Math.min(index, 12) * 60}ms` }}
            />
            <span
              className={cn(
                "absolute hidden -translate-y-[calc(100%+0.625rem)] items-baseline gap-1.5 rounded-md bg-popover px-1.5 py-0.5 text-[11px] leading-tight font-medium whitespace-nowrap text-popover-foreground shadow-elev-1 animate-enter @md:inline-flex",
                left < 12
                  ? "translate-x-[-0.5rem]"
                  : left > 88
                    ? "-translate-x-[calc(100%-0.5rem)]"
                    : "-translate-x-1/2",
              )}
              style={{ ...position, animationDelay: `${320 + Math.min(index, 12) * 60}ms` }}
            >
              {marker.regions.map((region, i) => (
                <span key={region.id} className="inline-flex items-baseline gap-1">
                  {i > 0 ? <span className="text-muted-foreground">·</span> : null}
                  {region.name}
                  <span className="font-mono text-[10px] text-muted-foreground">{region.code}</span>
                </span>
              ))}
            </span>
          </span>
        );
      })}
    </div>
  );
}
