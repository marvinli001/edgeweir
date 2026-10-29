import { Sparkline as ArcSparkline } from "@/components/arc/sparkline/sparkline";
import { cn } from "@/lib/utils";

/**
 * A small decorative trend (Arc's sparkline, bare and not scrubbable) beside a value that carries
 * the number. `tone="signal"` stays for live series; both draw in the brand line color.
 */
export function Sparkline({
  data,
  height = 36,
  fill = true,
  className,
}: {
  data: number[];
  tone?: "signal" | "metric";
  height?: number;
  fill?: boolean;
  className?: string;
}) {
  return (
    <div aria-hidden="true" className={cn("pointer-events-none min-w-0", className)}>
      <ArcSparkline
        data={data.length ? data : [0, 0]}
        label=""
        height={height}
        width={160}
        area={fill}
        interactive={false}
        bare
      />
    </div>
  );
}
