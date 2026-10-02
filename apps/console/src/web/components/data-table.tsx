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
} from "@/components/ui/table";

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

/** Thin TanStack Table v9 wrapper rendered with the shadcn table primitives. */
export function DataTable<T extends RowData>({
  data,
  columns,
  getRowId,
  testId,
}: {
  data: T[];
  columns: Columns<T>;
  getRowId: (row: T) => string;
  testId?: string;
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
  return (
    <div className="overflow-hidden rounded-2xl border bg-card shadow-xs" data-testid={testId}>
      <Table>
        <TableHeader className="bg-muted/60">
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead key={header.id} colSpan={header.colSpan}>
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
              style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
            >
              {row.getAllCells().map((cell) => (
                <TableCell key={cell.id} className="align-top">
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
