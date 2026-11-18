import {
  API_SECURITY_LIMITS,
  type ApiEndpoint,
  type ApiSecuritySettings,
} from "@edgeweir/contract";
import { useMutation } from "@tanstack/react-query";
import * as React from "react";
import { Input } from "@/components/arc/input/input";
import { Textarea } from "@/components/arc/textarea/textarea";
import { FormDialog } from "@/components/form-dialog";
import { Field, FieldError, FieldLabel } from "@/components/layout/form";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/layout/table";
import { SafetyNote } from "@/components/safety-note";
import { EmptyState } from "@/components/states";
import { formatNumber, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

type Preview = {
  openapiVersion: string;
  endpoints: ApiEndpoint[];
  issues: ApiSecuritySettings["schema"]["issues"];
};

export function ApiImportDialog({
  siteId,
  onClose,
  onApply,
}: {
  siteId: string;
  onClose: () => void;
  onApply: (preview: Preview) => void;
}) {
  const [document, setDocument] = React.useState("");
  const [fileError, setFileError] = React.useState<string | null>(null);
  const preview = useMutation(orpc.apiSecurity.importOpenApi.mutationOptions());
  const change = (value: string) => {
    setDocument(value);
    setFileError(null);
    preview.reset();
  };
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={m.api_security_import()}
      className="sm:max-w-3xl"
      submitLabel={preview.data ? m.api_security_use_preview() : m.api_security_preview()}
      submitTestId="api-import-submit"
      submitDisabled={!document.trim() || preview.isPending || !!fileError}
      onSubmit={async () => {
        if (preview.data) {
          onApply(preview.data);
          return;
        }
        if (new TextEncoder().encode(document).length > API_SECURITY_LIMITS.documentBytes)
          throw new Error(m.api_security_import_too_large());
        await preview.mutateAsync({ id: siteId, document });
      }}
    >
      <Field>
        <FieldLabel htmlFor="api-import-file">{m.api_security_import_file()}</FieldLabel>
        <Input
          id="api-import-file"
          type="file"
          accept=".json,application/json"
          disabled={preview.isPending}
          data-testid="api-import-file"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            if (file.size > API_SECURITY_LIMITS.documentBytes) {
              preview.reset();
              setFileError(m.api_security_import_too_large());
              return;
            }
            try {
              change(await file.text());
            } catch {
              setFileError(m.api_security_import_read_failed());
            }
          }}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="api-import-document">{m.api_security_openapi_json()}</FieldLabel>
        <Textarea
          id="api-import-document"
          rows={10}
          value={document}
          disabled={preview.isPending}
          spellCheck={false}
          wrap="off"
          className="font-mono text-xs"
          data-testid="api-import-document"
          onChange={(event) => change(event.target.value)}
        />
      </Field>
      {fileError ? <FieldError>{fileError}</FieldError> : null}
      {preview.data ? (
        <div className="flex min-w-0 flex-col gap-4" data-testid="api-import-preview">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>{m.api_security_openapi_version({ version: preview.data.openapiVersion })}</span>
            <span>
              {m.api_security_schema_count({ count: formatNumber(preview.data.endpoints.length) })}
            </span>
          </div>
          <ApiImportIssues issues={preview.data.issues} />
          <ApiSchemaEndpoints endpoints={preview.data.endpoints} />
        </div>
      ) : null}
    </FormDialog>
  );
}

export function ApiImportIssues({ issues }: { issues: ApiSecuritySettings["schema"]["issues"] }) {
  if (!issues.length) return null;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="api-import-issues">
      <SafetyNote>{m.api_security_issues_prevent_enforce()}</SafetyNote>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{m.api_security_issue_location()}</TableHead>
            <TableHead>{m.api_security_code()}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {issues.map((issue) => (
            <TableRow key={`${issue.location}-${issue.code}`}>
              <TableCell className="max-w-96 whitespace-normal break-all font-mono text-xs">
                {issue.location}
              </TableCell>
              <TableCell className="font-mono text-xs">{issue.code}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function ApiSchemaEndpoints({ endpoints }: { endpoints: ApiEndpoint[] }) {
  if (!endpoints.length) return <EmptyState title={m.api_security_schema_empty()} compact />;
  return (
    <div className="max-h-80 overflow-y-auto rounded-md border" data-testid="api-schema-endpoints">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{m.api_security_method()}</TableHead>
            <TableHead>{m.api_security_path()}</TableHead>
            <TableHead>{m.api_security_parameters()}</TableHead>
            <TableHead>{m.api_security_body()}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {endpoints.map((endpoint) => (
            <TableRow key={`${endpoint.method} ${endpoint.path}`}>
              <TableCell className="font-mono">{endpoint.method}</TableCell>
              <TableCell className="font-mono">{endpoint.path}</TableCell>
              <TableCell className="readout">{formatNumber(endpoint.parameters.length)}</TableCell>
              <TableCell>
                {endpoint.body
                  ? endpoint.body.required
                    ? m.api_security_required()
                    : m.api_security_optional()
                  : m.api_security_none()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
