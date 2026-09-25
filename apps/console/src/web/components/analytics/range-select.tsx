import type { AnalyticsRange } from "@edgeweir/contract";
import { Calendar03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ANALYTICS_RANGES, rangeLabel } from "@/lib/analytics";

export function RangeSelect({
  value,
  onChange,
}: {
  value: AnalyticsRange;
  onChange: (range: AnalyticsRange) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button size="sm" variant="outline" data-testid="analytics-range" />}
      >
        <HugeiconsIcon icon={Calendar03Icon} strokeWidth={2} />
        {rangeLabel(value)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(next as AnalyticsRange)}
        >
          {ANALYTICS_RANGES.map((range) => (
            <DropdownMenuRadioItem key={range} value={range} data-testid={`range-${range}`}>
              {rangeLabel(range)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
