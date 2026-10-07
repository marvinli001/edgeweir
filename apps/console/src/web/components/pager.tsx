import { ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@/components/ui/button";
import { formatNumber, m } from "@/lib/i18n";

/** "21–40 / 57" with previous/next buttons; hidden when everything fits on one page. */
export function Pager({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize && page <= 1) return null;
  const from = Math.min(total, (page - 1) * pageSize + 1);
  const to = Math.min(total, page * pageSize);
  return (
    <nav aria-label={m.pager_label()} className="flex items-center justify-end gap-2 text-sm">
      <span className="readout text-muted-foreground" data-testid="pager-range">
        {m.pager_range({
          from: formatNumber(from),
          to: formatNumber(to),
          total: formatNumber(total),
        })}
      </span>
      {/* Previous and next ride in one shallow track, like a segmented control. */}
      <div className="flex items-center gap-0.5 rounded-full p-0.5 seg-well">
        <Button
          size="icon-sm"
          variant="ghost"
          className="rounded-full"
          aria-label={m.pager_previous()}
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          className="rounded-full"
          aria-label={m.pager_next()}
          disabled={page >= pages}
          onClick={() => onPageChange(page + 1)}
          data-testid="pager-next"
        >
          <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
        </Button>
      </div>
    </nav>
  );
}
