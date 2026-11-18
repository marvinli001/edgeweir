import { API_METHODS, type ApiSecuritySettings, apiException } from "@edgeweir/contract";
import * as React from "react";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { Switch } from "@/components/arc/switch/switch";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect } from "@/components/form-select";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/layout/form";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/layout/table";
import { SwitchField } from "@/components/site/fields";
import { EmptyState } from "@/components/states";
import { apiCheckLabel, apiFieldLabel } from "@/lib/api-security-labels";
import { m } from "@/lib/i18n";
import { randomUuid } from "@/lib/uuid";

type Exception = ApiSecuritySettings["exceptions"][number];

export function ApiExceptions({
  value,
  onChange,
}: {
  value: Exception[];
  onChange: (next: Exception[]) => void;
}) {
  const [editing, setEditing] = React.useState<Exception | null>(null);
  const checks = ["schema", "jwt", "graphql"] as const;
  return (
    <FieldSet className="gap-4 border-t pt-5" data-testid="api-exceptions">
      <FieldLegend>{m.api_security_exceptions()}</FieldLegend>
      <div className="flex justify-end">
        <Button
          variant="secondary"
          disabled={value.length >= 100}
          data-testid="api-exception-add"
          onClick={() =>
            setEditing({
              id: randomUuid(),
              enabled: true,
              method: "*",
              path: "/",
              check: "schema",
              reason: "",
            })
          }
        >
          {m.api_security_exception_add()}
        </Button>
      </div>
      {value.length === 0 ? (
        <EmptyState title={m.api_security_exceptions_empty()} compact />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{m.api_security_enabled()}</TableHead>
              <TableHead>{m.api_security_check()}</TableHead>
              <TableHead>{m.api_security_method()}</TableHead>
              <TableHead>{m.api_security_path()}</TableHead>
              <TableHead>{m.api_security_exception_reason()}</TableHead>
              <TableHead>
                <span className="sr-only">{m.api_security_actions()}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {value.map((entry) => (
              <TableRow key={entry.id} data-testid="api-exception-row">
                <TableCell>
                  <Switch
                    checked={entry.enabled}
                    aria-label={m.api_security_exception_toggle({ path: entry.path })}
                    onCheckedChange={(enabled) =>
                      onChange(
                        value.map((row) => (row.id === entry.id ? { ...row, enabled } : row)),
                      )
                    }
                  />
                </TableCell>
                <TableCell>{apiCheckLabel(entry.check)}</TableCell>
                <TableCell className="font-mono">{entry.method}</TableCell>
                <TableCell className="max-w-72 truncate font-mono" title={entry.path}>
                  {entry.path}
                </TableCell>
                <TableCell className="max-w-72 truncate" title={entry.reason}>
                  {entry.reason}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing(entry)}
                      aria-label={m.api_security_exception_edit_path({ path: entry.path })}
                    >
                      {m.common_edit()}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onChange(value.filter((row) => row.id !== entry.id))}
                      aria-label={m.api_security_exception_delete_path({ path: entry.path })}
                    >
                      {m.common_delete()}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {editing ? (
        <ExceptionDialog
          key={editing.id}
          initial={editing}
          checks={checks}
          onClose={() => setEditing(null)}
          onDone={(entry) => {
            onChange(
              value.some((row) => row.id === entry.id)
                ? value.map((row) => (row.id === entry.id ? entry : row))
                : [...value, entry],
            );
            setEditing(null);
          }}
        />
      ) : null}
    </FieldSet>
  );
}

function ExceptionDialog({
  initial,
  checks,
  onClose,
  onDone,
}: {
  initial: Exception;
  checks: readonly Exception["check"][];
  onClose: () => void;
  onDone: (entry: Exception) => void;
}) {
  const [entry, setEntry] = React.useState(initial);
  const set = (change: Partial<Exception>) => setEntry({ ...entry, ...change });
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={m.api_security_exception_edit()}
      submitLabel={m.auth_done()}
      submitTestId="api-exception-done"
      onSubmit={async () => {
        const parsed = apiException.safeParse(entry);
        if (!parsed.success)
          throw new Error(
            m.common_check_field({
              field: apiFieldLabel(parsed.error.issues[0]?.path.join(".") ?? ""),
            }),
          );
        onDone(parsed.data);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <FormSelect
          id="api-exception-check"
          label={m.api_security_check()}
          value={entry.check}
          options={checks.map((check) => ({ value: check, label: apiCheckLabel(check) }))}
          onChange={(check) => set({ check })}
          testId="api-exception-check"
        />
        <FormSelect
          id="api-exception-method"
          label={m.api_security_method()}
          value={entry.method}
          options={[
            { value: "*", label: m.api_security_all_methods() },
            ...API_METHODS.map((value) => ({ value, label: value })),
          ]}
          onChange={(method) => set({ method })}
          testId="api-exception-method"
        />
      </div>
      <Field>
        <FieldLabel htmlFor="api-exception-path">{m.api_security_path()}</FieldLabel>
        <Input
          id="api-exception-path"
          value={entry.path}
          maxLength={512}
          required
          spellCheck={false}
          className="font-mono"
          onChange={(event) => set({ path: event.target.value })}
          data-testid="api-exception-path"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="api-exception-reason">{m.api_security_exception_reason()}</FieldLabel>
        <Input
          id="api-exception-reason"
          value={entry.reason}
          maxLength={256}
          required
          onChange={(event) => set({ reason: event.target.value })}
          data-testid="api-exception-reason"
        />
      </Field>
      <SwitchField
        id="api-exception-enabled"
        label={m.api_security_enabled()}
        checked={entry.enabled}
        onCheckedChange={(enabled) => set({ enabled })}
        testId="api-exception-enabled"
      />
    </FormDialog>
  );
}
