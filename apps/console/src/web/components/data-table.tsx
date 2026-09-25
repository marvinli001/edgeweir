import {
  type ColumnDef,
  createSortedRowModel,
  FlexRender,
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
                  {header.isPlaceholder ? null : <FlexRender header={header} />}
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
                  <FlexRender cell={cell} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
