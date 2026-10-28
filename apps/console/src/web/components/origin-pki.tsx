import {
  type CertificateAuthorityDto,
  ORIGIN_CERTIFICATE_VALIDITY_YEARS,
  type OriginCertificateIssued,
  type OriginCertificateKeyType,
} from "@edgeweir/contract";
import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Textarea } from "@/components/arc/textarea/textarea";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CodeBlock } from "@/components/copy-button";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect } from "@/components/form-select";
import { enterDelay } from "@/components/page";
import { SafetyNote } from "@/components/safety-note";
import { EmptyState, QueryView } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { useAction } from "@/hooks/use-action";
import type { DialogProps } from "@/hooks/use-dialog-state";
import { downloadText } from "@/lib/browser";
import { formatDateTime, m } from "@/lib/i18n";
import { splitList } from "@/lib/lists";
import { orpc } from "@/lib/orpc";

const KEY_TYPES = [
  { label: "ECDSA P-256", value: "ec256" },
  { label: "RSA 2048", value: "rsa2048" },
] satisfies { label: string; value: OriginCertificateKeyType }[];

const KEY_TYPE_LABELS: Record<string, string> = {
  ec256: "ECDSA P-256",
  ec384: "ECDSA P-384",
  rsa2048: "RSA 2048",
  rsa3072: "RSA 3072",
  rsa4096: "RSA 4096",
};

/** An authority's certificate: fingerprint, validity and a download, with the rotation's actions. */
function AuthorityCard({
  title,
  authority,
  file,
  testId,
  index = 0,
  actions,
  children,
}: {
  title: string;
  authority: CertificateAuthorityDto;
  file: string;
  testId: string;
  index?: number;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <Card className="animate-enter" style={enterDelay(index)} data-testid={testId}>
      <CardHeader className="flex flex-row flex-wrap items-center gap-3">
        <CardTitle className="flex-1">{title}</CardTitle>
        {actions}
        <Button
          size="sm"
          variant="secondary"
          onClick={() => downloadText(file, authority.certificatePem)}
          data-testid={`${testId}-download`}
        >
          {m.origin_ca_download()}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Field>
          <FieldLabel>{m.system_ca_fingerprint()}</FieldLabel>
          <CodeBlock value={authority.fingerprint} testId={`${testId}-fingerprint`} />
        </Field>
        <p className="text-sm text-muted-foreground">
          {m.origin_ca_valid_until({ date: formatDateTime(authority.notAfter) })}
        </p>
        {children}
      </CardContent>
    </Card>
  );
}

// A rotation step publishes the clusters or changes what they present.
const STEP_META = { invalidates: "all" } as const;

/** A rotation step behind a confirmation, whose failure stays in the dialog. */
function StepButton({
  label,
  title,
  note,
  destructive = false,
  disabled = false,
  run,
  testId,
}: {
  label: string;
  title: string;
  note?: string;
  destructive?: boolean;
  disabled?: boolean;
  run: () => Promise<unknown>;
  testId: string;
}) {
  return (
    <ConfirmDialog
      title={title}
      {...(note ? { note } : {})}
      destructive={destructive}
      confirmLabel={label}
      trigger={
        <Button
          size="sm"
          variant={destructive ? "danger" : "secondary"}
          disabled={disabled}
          data-testid={testId}
        >
          {label}
        </Button>
      }
      onConfirm={run}
    />
  );
}

// A new authority issues certificates the clusters' nodes use.
const CREATE_META = { invalidates: "all", toastError: true } as const;

/** Creates an authority: the empty state's action (the mutation's meta refreshes and toasts errors). */
function CreateAuthority({
  title,
  label,
  create,
  testId,
}: {
  title: string;
  label: string;
  create: () => Promise<unknown>;
  testId: string;
}) {
  const action = useAction();
  return (
    <EmptyState title={title}>
      <Button
        disabled={action.pending}
        data-testid={testId}
        onClick={() => void action.run(create).catch(() => undefined)}
      >
        {action.pending ? <Spinner /> : <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />}
        {label}
      </Button>
    </EmptyState>
  );
}

/**
 * The Origin CA and the certificates it issued for origins: issue (a generated key shown once, or
 * a CSR), download and revoke.
 */
export function OriginCaPanel({ issue }: { issue: DialogProps & { key: number } }) {
  const ca = useQuery(orpc.originCa.get.queryOptions());
  const create = useMutation({ ...orpc.originCa.create.mutationOptions(), meta: CREATE_META });
  const rotate = useMutation({ ...orpc.originCa.rotate.mutationOptions(), meta: STEP_META });
  const retire = useMutation({ ...orpc.originCa.retire.mutationOptions(), meta: STEP_META });
  const cancel = useMutation({ ...orpc.originCa.cancel.mutationOptions(), meta: STEP_META });
  return (
    <div className="flex flex-col gap-6">
      <QueryView query={ca}>
        {({ authority, previous, previousCertificates }) =>
          authority ? (
            <>
              <AuthorityCard
                title={m.origin_ca_title()}
                authority={authority}
                file="origin-ca.pem"
                testId="origin-ca"
                actions={
                  previous ? null : (
                    <StepButton
                      label={m.origin_ca_rotate()}
                      title={m.origin_ca_rotate_confirm()}
                      note={m.origin_ca_rotate_note()}
                      run={() => rotate.mutateAsync(undefined)}
                      testId="origin-ca-rotate"
                    />
                  )
                }
              />
              {previous ? (
                <AuthorityCard
                  title={m.origin_ca_previous_title()}
                  authority={previous}
                  file="origin-ca-previous.pem"
                  testId="origin-ca-previous"
                  index={1}
                  actions={
                    <>
                      <StepButton
                        label={m.origin_ca_rotation_cancel()}
                        title={m.origin_ca_rotation_cancel_confirm()}
                        run={() => cancel.mutateAsync(undefined)}
                        testId="origin-ca-rotation-cancel"
                      />
                      <StepButton
                        label={m.origin_ca_retire()}
                        title={m.origin_ca_retire_confirm()}
                        {...(previousCertificates
                          ? { note: m.origin_ca_retire_note({ count: previousCertificates }) }
                          : {})}
                        destructive
                        run={() => retire.mutateAsync(undefined)}
                        testId="origin-ca-retire"
                      />
                    </>
                  }
                >
                  <p
                    className="text-sm text-muted-foreground"
                    data-testid="origin-ca-previous-certificates"
                  >
                    {m.origin_ca_previous_certificates({ count: previousCertificates })}
                  </p>
                </AuthorityCard>
              ) : null}
              <OriginCertificates onIssue={() => issue.onOpenChange(true)} />
            </>
          ) : (
            <CreateAuthority
              title={m.origin_ca_empty()}
              label={m.origin_ca_create()}
              create={() => create.mutateAsync(undefined)}
              testId="origin-ca-create"
            />
          )
        }
      </QueryView>
      {issue.key ? (
        <IssueDialog key={issue.key} open={issue.open} onOpenChange={issue.onOpenChange} />
      ) : null}
    </div>
  );
}

function OriginCertificates({ onIssue }: { onIssue: () => void }) {
  const certificates = useQuery(orpc.originCertificates.list.queryOptions());
  const revoke = useMutation({
    ...orpc.originCertificates.revoke.mutationOptions(),
    meta: { invalidates: "all" },
  });
  return (
    <QueryView
      query={certificates}
      empty={
        <EmptyState title={m.origin_cert_empty()}>
          <Button onClick={onIssue} data-testid="origin-cert-issue-empty">
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.origin_cert_issue()}
          </Button>
        </EmptyState>
      }
    >
      {(list) => (
        <ul
          className="flex flex-col divide-y rounded-2xl bg-card shadow-elev-1 edge-lit"
          data-testid="origin-cert-list"
        >
          {list.map((cert, index) => (
            <li
              key={cert.id}
              className="grid gap-x-6 gap-y-3 px-5 py-4 animate-enter @3xl/main:grid-cols-[minmax(0,1fr)_minmax(0,18rem)_auto]"
              style={enterDelay(index)}
              data-testid="origin-cert"
            >
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge size="sm" tone="neutral">
                    {KEY_TYPE_LABELS[cert.keyType] ?? cert.keyType}
                  </Badge>
                  {cert.source === "csr" ? (
                    <Badge size="sm" tone="neutral">
                      CSR
                    </Badge>
                  ) : null}
                  <AuthorityBadge authority={cert.authority} />
                  {cert.revokedAt ? (
                    <Badge size="sm" tone="danger" data-testid="origin-cert-revoked">
                      {m.origin_cert_revoked()}
                    </Badge>
                  ) : null}
                </div>
                <p className="font-mono text-xs leading-5 break-all text-muted-foreground">
                  {cert.hostnames.join(", ")}
                </p>
              </div>
              <div className="flex min-w-0 flex-col gap-1 text-sm text-muted-foreground">
                <span>{m.origin_ca_valid_until({ date: formatDateTime(cert.notAfter) })}</span>
                <span className="font-mono text-xs break-all">{cert.serial}</span>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2 @3xl/main:justify-end">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    downloadText(`${fileStem(cert.hostnames[0])}.pem`, cert.certificatePem)
                  }
                >
                  {m.origin_cert_download()}
                </Button>
                {cert.revokedAt ? null : (
                  <ConfirmDialog
                    title={m.origin_cert_revoke_confirm({ name: cert.hostnames[0] ?? "" })}
                    destructive
                    trigger={
                      <Button size="sm" variant="danger" data-testid="origin-cert-revoke">
                        {m.origin_cert_revoke()}
                      </Button>
                    }
                    onConfirm={async () => {
                      await revoke.mutateAsync({ id: cert.id });
                    }}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </QueryView>
  );
}

/** Marks a certificate a rotation's previous authority, or a retired one, issued. */
function AuthorityBadge({ authority }: { authority: "active" | "previous" | "retired" }) {
  if (authority === "active") return null;
  return (
    <Badge size="sm" tone="neutral" data-testid={`cert-authority-${authority}`}>
      {authority === "previous" ? m.origin_cert_previous_ca() : m.origin_cert_retired_ca()}
    </Badge>
  );
}

/** A file name from a host name: "*.example.com" → "wildcard.example.com". */
const fileStem = (name = "origin") =>
  name.replace(/^\*\./, "wildcard.").replace(/[^a-z0-9.-]/gi, "_");

function IssueDialog({ open, onOpenChange }: DialogProps) {
  const issue = useMutation({
    ...orpc.originCertificates.issue.mutationOptions(),
    meta: { invalidates: "all" },
  });
  const [hostnames, setHostnames] = React.useState("");
  const [csr, setCsr] = React.useState("");
  const [validity, setValidity] = React.useState("15");
  const [keyType, setKeyType] = React.useState<OriginCertificateKeyType>("ec256");
  const [issued, setIssued] = React.useState<OriginCertificateIssued | null>(null);
  const years = ORIGIN_CERTIFICATE_VALIDITY_YEARS.map((count) => ({
    value: String(count),
    label: m.origin_cert_years({ count }),
  }));
  if (issued)
    return (
      <FormDialog
        open={open}
        onOpenChange={onOpenChange}
        title={m.origin_cert_issued_title()}
        submitLabel={m.common_close()}
        submitTestId="origin-cert-done"
        onSubmit={async () => onOpenChange(false)}
      >
        <Field>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <FieldLabel>{m.origin_cert_certificate()}</FieldLabel>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() =>
                downloadText(`${fileStem(issued.hostnames[0])}.pem`, issued.certificatePem)
              }
            >
              {m.origin_cert_download()}
            </Button>
          </div>
          <CodeBlock value={issued.certificatePem} testId="origin-cert-pem" />
        </Field>
        {issued.privateKeyPem ? (
          <Field>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <FieldLabel>{m.origin_cert_private_key()}</FieldLabel>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() =>
                  downloadText(`${fileStem(issued.hostnames[0])}.key`, issued.privateKeyPem)
                }
              >
                {m.origin_cert_download_key()}
              </Button>
            </div>
            <CodeBlock value={issued.privateKeyPem} testId="origin-cert-key" />
            <SafetyNote>{m.origin_cert_key_shown_once()}</SafetyNote>
          </Field>
        ) : null}
      </FormDialog>
    );
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.origin_cert_issue()}
      submitLabel={m.origin_cert_issue()}
      submitTestId="origin-cert-issue-submit"
      onSubmit={async () => {
        const result = await issue.mutateAsync({
          hostnames: splitList(hostnames),
          validityYears: Number(validity) as (typeof ORIGIN_CERTIFICATE_VALIDITY_YEARS)[number],
          keyType,
          ...(csr.trim() ? { csrPem: csr.trim() } : {}),
        });
        setIssued(result);
      }}
    >
      <Field>
        <FieldLabel htmlFor="origin-cert-hostnames">{m.origin_cert_hostnames()}</FieldLabel>
        <Textarea
          id="origin-cert-hostnames"
          value={hostnames}
          onChange={(e) => setHostnames(e.target.value)}
          placeholder={m.origin_cert_hostnames_placeholder()}
          required
          rows={3}
          spellCheck={false}
          data-testid="origin-cert-hostnames"
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormSelect
          id="origin-cert-validity"
          label={m.origin_cert_validity()}
          value={validity}
          options={years}
          onChange={setValidity}
          testId="origin-cert-validity"
        />
        <FormSelect
          id="origin-cert-key-type"
          label={m.origin_cert_key_type()}
          value={keyType}
          options={KEY_TYPES}
          // A CSR brings its own key.
          disabled={csr.trim() !== ""}
          onChange={setKeyType}
          testId="origin-cert-key-type"
        />
      </div>
      <Field>
        <FieldLabel htmlFor="origin-cert-csr">{m.origin_cert_csr()}</FieldLabel>
        <Textarea
          id="origin-cert-csr"
          value={csr}
          onChange={(e) => setCsr(e.target.value)}
          rows={4}
          spellCheck={false}
          autoComplete="off"
          data-testid="origin-cert-csr"
        />
      </Field>
    </FormDialog>
  );
}

/**
 * The origin client CA, which origins verifying clients trust, and the certificate each cluster's
 * nodes present to them; during a rotation the next or previous authority beside it.
 */
export function OriginClientPanel() {
  const ca = useQuery(orpc.originClientCa.get.queryOptions());
  const create = useMutation({
    ...orpc.originClientCa.create.mutationOptions(),
    meta: CREATE_META,
  });
  const rotate = useMutation({ ...orpc.originClientCa.rotate.mutationOptions(), meta: STEP_META });
  const activate = useMutation({
    ...orpc.originClientCa.activate.mutationOptions(),
    meta: STEP_META,
  });
  const retire = useMutation({ ...orpc.originClientCa.retire.mutationOptions(), meta: STEP_META });
  const cancel = useMutation({ ...orpc.originClientCa.cancel.mutationOptions(), meta: STEP_META });
  return (
    <QueryView query={ca}>
      {({ authority, next, previous, trustBundlePem, certificates, pendingClusters }) =>
        authority ? (
          <div className="flex flex-col gap-6">
            <AuthorityCard
              title={m.origin_client_ca_title()}
              authority={authority}
              file="origin-client-ca.pem"
              testId="origin-client-ca"
              actions={
                next || previous ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => downloadText("origin-client-ca-bundle.pem", trustBundlePem)}
                    data-testid="origin-client-ca-bundle"
                  >
                    {m.origin_ca_trust_bundle()}
                  </Button>
                ) : (
                  <StepButton
                    label={m.origin_ca_rotate()}
                    title={m.origin_client_ca_rotate_confirm()}
                    note={m.origin_client_ca_rotate_note()}
                    run={() => rotate.mutateAsync(undefined)}
                    testId="origin-client-ca-rotate"
                  />
                )
              }
            />
            {next ? (
              <AuthorityCard
                title={m.origin_client_ca_next_title()}
                authority={next}
                file="origin-client-ca-next.pem"
                testId="origin-client-ca-next"
                index={1}
                actions={
                  <>
                    <StepButton
                      label={m.origin_ca_rotation_cancel()}
                      title={m.origin_ca_rotation_cancel_confirm()}
                      run={() => cancel.mutateAsync(undefined)}
                      testId="origin-client-ca-rotation-cancel"
                    />
                    <StepButton
                      label={m.origin_client_ca_activate()}
                      title={m.origin_client_ca_activate_confirm()}
                      note={m.origin_client_ca_activate_note()}
                      run={() => activate.mutateAsync(undefined)}
                      testId="origin-client-ca-activate"
                    />
                  </>
                }
              />
            ) : null}
            {previous ? (
              <AuthorityCard
                title={m.origin_client_ca_previous_title()}
                authority={previous}
                file="origin-client-ca-previous.pem"
                testId="origin-client-ca-previous"
                index={1}
                actions={
                  <StepButton
                    label={m.origin_ca_retire()}
                    title={m.origin_client_ca_retire_confirm()}
                    destructive
                    disabled={pendingClusters.length > 0}
                    run={() => retire.mutateAsync(undefined)}
                    testId="origin-client-ca-retire"
                  />
                }
              >
                {pendingClusters.length ? (
                  <p
                    className="text-sm text-muted-foreground"
                    data-testid="origin-client-ca-pending"
                  >
                    {m.origin_client_ca_pending({
                      clusters: pendingClusters.map((c) => c.clusterName).join(", "),
                    })}
                  </p>
                ) : null}
              </AuthorityCard>
            ) : null}
            <Card className="animate-enter" style={enterDelay(next || previous ? 2 : 1)}>
              <CardHeader>
                <CardTitle>{m.origin_client_certificates_title()}</CardTitle>
              </CardHeader>
              <CardContent>
                {certificates.length === 0 ? (
                  <EmptyState compact title={m.origin_client_certificates_empty()} />
                ) : (
                  <ul className="flex flex-col divide-y" data-testid="origin-client-certificates">
                    {certificates.map((cert, index) => (
                      <li
                        key={cert.id}
                        className="flex flex-wrap items-center gap-x-6 gap-y-1 py-3 animate-enter first:pt-0 last:pb-0"
                        style={enterDelay(index)}
                      >
                        <span className="min-w-40 flex-1 font-medium">{cert.clusterName}</span>
                        <AuthorityBadge authority={cert.authority} />
                        <span className="text-sm text-muted-foreground">
                          {m.origin_ca_valid_until({ date: formatDateTime(cert.notAfter) })}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        ) : (
          <CreateAuthority
            title={m.origin_client_ca_empty()}
            label={m.origin_client_ca_create()}
            create={() => create.mutateAsync(undefined)}
            testId="origin-client-ca-create"
          />
        )
      }
    </QueryView>
  );
}
