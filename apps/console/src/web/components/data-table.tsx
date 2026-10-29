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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/layout/table";
import { enterDelay } from "@/components/page";
import { formatNumber, m } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
});

/**
 * How a column shows where the table stacks into cards (`stack` on DataTable, a narrow column):
 * `lead` is the card's first line (the row's name and its row link), `aside` sits beside it (a
 * state), `end` at the line's end (the row's menu), `hide` leaves it out; every other column is a
 * labeled line under them. `hideBelow`
 * drops a column of secondary detail where the column is narrower than that (`lg`, `xl`), before
 * the table scrolls sideways, and from the cards.
 */
export interface ColumnLayout {
  stack?: "lead" | "aside" | "end" | "hide";
  hideBelow?: "lg" | "xl";
}

export type Columns<T extends RowData> = (ColumnDef<typeof features, T> & ColumnLayout)[];

const HIDE_BELOW: Record<NonNullable<ColumnLayout["hideBelow"]>, string> = {
  lg: "@max-5xl/main:hidden",
  xl: "@max-6xl/main:hidden",
};

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
 * Measures whether a table is wider than its container: `data-overflow` on the container while
 * it scrolls sideways (a pinned first column, `cell-pinned`, needs it), nothing while it fits (a
 * DataTable's header then sticks under the page header, since the container no longer scrolls).
 * `root` is the table or an element that holds one; a ref callback (it returns its cleanup) for
 * the plain tables in cards (CardTable) and wells.
 */
export function markOverflow(root: HTMLElement | null): (() => void) | undefined {
  const element = root?.matches("table") ? root : root?.querySelector("table");
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
}

const layoutClass = (def: ColumnLayout) => (def.hideBelow ? HIDE_BELOW[def.hideBelow] : undefined);

function useOverflowMark(table: React.RefObject<HTMLTableElement | null>) {
  React.useLayoutEffect(() => markOverflow(table.current), [table]);
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

/** A column header as plain text (the label of a stacked cell), when it is one. */
function headerText(header: unknown, props: object): string | undefined {
  const value = typeof header === "function" ? header(props) : header;
  return typeof value === "string" ? value : undefined;
}

/**
 * Thin TanStack Table v9 wrapper on the layout table parts, in a hairline panel. The header is a
 * faint strip that sticks under the top bar while the table fits its panel; rows enter staggered;
 * the footer counts the rows (`total`, else the rows shown) and holds the `footer` (a Pager). A row whose cells hold a row link (`rowLink`) opens it on a click anywhere in the row
 * (TableRow). `pinFirstColumn` keeps the first column in place while the table scrolls sideways,
 * for tables whose first column names the row; on phones every row is a card (columns say how
 * they show there: ColumnLayout), so the table never scrolls sideways there.
 */
export function DataTable<T extends RowData>({
  data,
  columns,
  getRowId,
  testId,
  pinFirstColumn = false,
  stack = true,
  total,
  footer,
}: {
  data: T[];
  columns: Columns<T>;
  getRowId: (row: T) => string;
  testId?: string;
  pinFirstColumn?: boolean;
  /** Rows as cards on phones (the default); off for tables that read as a grid there too. */
  stack?: boolean;
  /** Every row of the list when the table shows one page of it. */
  total?: number;
  footer?: React.ReactNode;
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
  const hasLead = columns.some((column) => column.stack === "lead");
  const pinned = (index: number) => pinFirstColumn && index === 0 && "cell-pinned";
  return (
    <div
      // overflow-clip rounds the corners without becoming a scroll container (sticky header).
      className="overflow-clip rounded-lg border bg-card"
      data-slot="data-table"
      data-stack={stack ? "" : undefined}
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
                  className={cn(
                    "bg-well [--cell-bg:var(--well)]",
                    pinned(index),
                    layoutClass(header.column.columnDef as ColumnLayout),
                  )}
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
              {row.getAllCells().map((cell, cellIndex) => {
                const def = cell.column.columnDef as ColumnLayout;
                // The first column leads the card unless another one does, the row's menu
                // ("actions") ends its first line, and a column of secondary detail is left out.
                const place =
                  def.stack ??
                  (cellIndex === 0 && !hasLead
                    ? "lead"
                    : cell.column.id === "actions"
                      ? "end"
                      : def.hideBelow
                        ? "hide"
                        : undefined);
                return (
                  <TableCell
                    key={cell.id}
                    className={cn("align-top", pinned(cellIndex), layoutClass(def))}
                    data-stack={stack ? place : undefined}
                    data-label={
                      stack && !place
                        ? headerText(cell.column.columnDef.header, cell.getContext())
                        : undefined
                    }
                  >
                    {renderTemplate(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-4 py-2.5 text-dense text-muted-foreground"
        data-slot="table-footer"
      >
        <span className="readout" data-testid="table-total">
          {m.table_total({ count: formatNumber(total ?? data.length) })}
        </span>
        {footer ? <div className="ml-auto">{footer}</div> : null}
      </div>
    </div>
  );
}
