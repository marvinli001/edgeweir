import {
  type ColumnDef,
  createSortedRowModel,
  type RowData,
  rowSortingFeature,
  type SortingState,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import * as React from "react";
import { enterDelay } from "@/components/page";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

export const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
});

export type Columns<T extends RowData> = ColumnDef<typeof features, T>[];

/**
 * Renders a column's `header` or `cell` template by calling it. TanStack's `FlexRender` passes a
 * template function to `createElement`, so each new `columns` array (a memo dependency changed,
 * the list polled) gave every cell a new component type and remounted it, closing the dialogs and
 * menus open in it. Templates are plain functions here and must not call hooks; a cell that needs
 * state renders a component of its own.
 */
function renderTemplate<P extends object>(
  template: string | ((props: P) => unknown) | undefined,
  props: P,
): React.ReactNode {
  return (typeof template === "function" ? template(props) : template) as React.ReactNode;
}

/**
 * Measures whether the table is wider than its container: `data-overflow` on the container while
 * it scrolls sideways (the pinned first column needs it), nothing while it fits (its header then
 * sticks under the page header, since the container no longer scrolls).
 */
function useOverflowMark(table: React.RefObject<HTMLTableElement | null>) {
  React.useLayoutEffect(() => {
    const element = table.current;
    const container = element?.parentElement;
    if (!element || !container) return;
    const measure = () =>
      container.toggleAttribute("data-overflow", element.offsetWidth > container.clientWidth + 1);
    measure();
    // Later changes apply on the next frame: toggling the container's overflow inside the
    // observer's callback could resize what it observes (a scrollbar) and loop.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(container);
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [table]);
}

/** Filters above a table (a SearchBox, FilterSelects): one wrapping row. */
export function FilterBar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="filter-bar"
      className={cn("flex flex-wrap items-center gap-2", className)}
      {...props}
    />
  );
}

/**
 * Thin TanStack Table v9 wrapper rendered with the shadcn table primitives, in a card. The header
 * is a well strip that sticks under the page header while the table fits its card; rows enter
 * staggered. `pinFirstColumn` keeps the first column in place while the table scrolls sideways
 * (narrow screens), for tables whose first column names the row.
 */
export function DataTable<T extends RowData>({
  data,
  columns,
  getRowId,
  testId,
  pinFirstColumn = false,
}: {
  data: T[];
  columns: Columns<T>;
  getRowId: (row: T) => string;
  testId?: string;
  pinFirstColumn?: boolean;
}) {
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const table = useTable({
    features,
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getRowId: (row) => getRowId(row),
  });
  const ref = React.useRef<HTMLTableElement>(null);
  useOverflowMark(ref);
  const pinned = (index: number) => pinFirstColumn && index === 0 && "cell-pinned";
  return (
    <div
      // overflow-clip rounds the corners without becoming a scroll container (sticky header).
      className="overflow-clip rounded-2xl bg-card shadow-elev-1 edge-lit"
      data-slot="data-table"
      data-testid={testId}
    >
      <Table ref={ref}>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header, index) => (
                <TableHead
                  key={header.id}
                  colSpan={header.colSpan}
                  className={cn("bg-well [--cell-bg:var(--well)]", pinned(index))}
                >
                  {header.isPlaceholder
                    ? null
                    : renderTemplate(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row, index) => (
            <TableRow
              key={row.id}
              data-row-id={row.id}
              className="animate-enter"
              style={enterDelay(index)}
            >
              {row.getAllCells().map((cell, cellIndex) => (
                <TableCell key={cell.id} className={cn("align-top", pinned(cellIndex))}>
                  {renderTemplate(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
