import {
  type AcmeCa,
  type CertificateDto,
  CLIENT_CERTIFICATE_DEPTH_RANGE,
  CLIENT_CERTIFICATE_MODES,
  type ClientCertificateMode,
  certificateUnloadable,
  displaySiteDomain,
  HTTPS_REDIRECT_STATUSES,
  type HttpsCheck,
  MAX_SITE_CERTIFICATES,
  type Site,
  siteDomainKind,
  type TlsSettings,
  tlsSettings,
} from "@edgeweir/contract";
import { Add01Icon, Alert02Icon, ArrowDown01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { AcmeCaFields, caLabel, type Eab, eabMissing, eabParams } from "@/components/acme-ca";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DnsCredentialDialog } from "@/components/dns/credential-dialog";
import { FormSelect, OptionSelect } from "@/components/form-select";
import { SafetyNote } from "@/components/safety-note";
import { COMPRESSION_KEYS, compressionOf } from "@/components/site/compression-card";
import { NumberField, SwitchField } from "@/components/site/fields";
import { CheckboxList } from "@/components/site/ports-card";
import { SaveBar } from "@/components/site/save-site";
import { combineQueries, ErrorState, QueryView } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useDialogState } from "@/hooks/use-dialog-state";
import { certificateErrorText } from "@/lib/certificate-errors";
import { httpsBlockerText } from "@/lib/https-blockers";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

const CLIENT_MODE_LABEL = {
  off: m.https_client_cert_off,
  optional: m.https_client_cert_optional,
  required: m.https_client_cert_required,
};

/** How often the tab looks at a certificate being issued. */
const POLL = 3000;

const busy = (cert: CertificateDto | undefined) =>
  cert?.status === "pending" || cert?.status === "issuing";
/** Issued and not expired. */
const issuedValid = (cert: CertificateDto) =>
  !!cert.fingerprint && !!cert.notAfter && Date.parse(cert.notAfter) > Date.now();
/** Issued, not expired, and loadable by nodes: one a site can be given. */
const usable = (cert: CertificateDto) => issuedValid(cert) && !certificateUnloadable(cert);

/**
 * A site's HTTPS: the settings while it has a certificate; the certificate
 * requested for it while it is issued; else one click to enable HTTPS.
 */
export function HttpsTab({ site }: { site: Site }) {
  const client = useQueryClient();
  const [polling, setPolling] = React.useState(false);
  const policy = useQuery({
    ...orpc.https.get.queryOptions({ input: { id: site.id } }),
    refetchInterval: polling ? POLL : false,
    meta: { background: true },
  });
  const certificates = useQuery({
    ...orpc.certificates.list.queryOptions(),
    refetchInterval: polling ? POLL : false,
    meta: { background: true },
  });
  const bound = certificates.data?.find((c) => c.id === policy.data?.certificateId);
  const waiting = certificates.data?.find((c) => c.bindSiteId === site.id);
  React.useEffect(() => setPolling(busy(waiting) || busy(bound)), [waiting, bound]);
  // Issued and bound: the settings take over once they name the certificate.
  const issued = React.useRef<string | undefined>(undefined);
  const [settling, setSettling] = React.useState<CertificateDto | null>(null);
  React.useEffect(() => {
    const before = issued.current;
    issued.current = waiting?.id;
    const after = before && !waiting ? certificates.data?.find((c) => c.id === before) : undefined;
    if (after?.status !== "ready") return;
    setSettling(after);
    void client.invalidateQueries().finally(() => setSettling(null));
  }, [waiting, certificates.data, client]);

  const requested = waiting ?? settling;
  return (
    <QueryView query={combineQueries(policy, certificates)}>
      {([saved, list]) =>
        bound && (issuedValid(bound) || bound.source === "acme") ? (
          <div className="grid gap-4">
            {bound.status === "ready" ? null : <CertificateState cert={bound} />}
            <HttpsEditor
              // Keyed by its own fields: saving compression on the cache tab keeps unsaved edits here.
              key={JSON.stringify(httpsOf(saved))}
              site={site}
              initial={saved}
              certificates={list}
            />
          </div>
        ) : requested ? (
          <RequestedCertificate cert={requested} />
        ) : (
          <EnableHttps site={site} current={saved} />
        )
      }
    </QueryView>
  );
}

/** The status of a certificate being issued or that failed, with a retry. */
function CertificateState({ cert, actions }: { cert: CertificateDto; actions?: React.ReactNode }) {
  const client = useQueryClient();
  const renew = useMutation(orpc.certificates.renew.mutationOptions());
  const failed = cert.status === "error";
  // Only an ACME certificate is issued again; an upload is replaced.
  const retry = cert.source === "acme";
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl sunk-well px-4 py-3 text-sm animate-enter"
      data-testid="https-certificate-state"
    >
      {failed ? (
        <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="size-4 text-destructive" />
      ) : (
        <Spinner />
      )}
      <span className="min-w-48 flex-1 break-words">
        <span className="font-medium">{cert.name}</span>
        <span className="text-muted-foreground"> · </span>
        <span className={failed ? "text-destructive" : "text-muted-foreground"}>
          {failed
            ? certificateErrorText(cert.lastError) || m.cert_status_error()
            : cert.status === "issuing"
              ? m.cert_status_issuing()
              : m.cert_status_pending()}
        </span>
      </span>
      {failed ? (
        <div className="flex gap-2">
          {actions}
          {retry ? (
            <Button
              size="sm"
              variant="outline"
              disabled={renew.isPending}
              onClick={async () => {
                try {
                  await renew.mutateAsync({ id: cert.id });
                  await client.invalidateQueries();
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              {renew.isPending ? <Spinner /> : null}
              {m.common_retry()}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The certificate requested for the site: issuing, or why it failed (retry or cancel). */
function RequestedCertificate({ cert }: { cert: CertificateDto }) {
  const client = useQueryClient();
  const remove = useMutation(orpc.certificates.delete.mutationOptions());
  const failed = cert.status === "error";
  return (
    <Card className="animate-enter" data-testid="https-requested">
      <CardHeader>
        <CardTitle>{failed ? m.https_off() : m.https_requesting()}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-sm break-words text-muted-foreground">{cert.names.join(", ")}</p>
        <CertificateState
          cert={cert}
          actions={
            <ConfirmDialog
              title={m.cert_delete_confirm({ name: cert.name })}
              destructive
              trigger={
                <Button size="sm" variant="ghost">
                  {m.common_cancel()}
                </Button>
              }
              onConfirm={async () => {
                await remove.mutateAsync({ id: cert.id });
                await client.invalidateQueries();
              }}
            />
          }
        />
      </CardContent>
    </Card>
  );
}

/**
 * One click: a certificate for the site's domains, bound to it once issued.
 * The button waits for https.check; its blockers are listed instead.
 */
function EnableHttps({ site, current }: { site: Site; current: TlsSettings }) {
  const client = useQueryClient();
  const settings = useQuery(orpc.certificates.settings.queryOptions());
  const [chosenCa, setCa] = React.useState<AcmeCa | null>(null);
  // Until one is chosen: the default (custom while EDGEWEIR_ACME_DIRECTORY sets it).
  const ca = chosenCa ?? settings.data?.defaultCa ?? "letsencrypt";
  // The DNS-01 check asks the provider: not again on every focus.
  const check = useQuery({
    ...orpc.https.check.queryOptions({ input: { id: site.id, ca } }),
    staleTime: 30_000,
    enabled: settings.isSuccess,
  });
  const request = useMutation(orpc.certificates.request.mutationOptions());
  const update = useMutation(orpc.https.update.mutationOptions());
  const [email, setEmail] = React.useState<string | null>(null);
  const [eab, setEab] = React.useState<Eab>({ kid: "", key: "" });
  const [existing, setExisting] = React.useState<string | null>(null);
  const addCredential = useDialogState();
  const [customize, setCustomize] = React.useState(false);
  const [skipDns, setSkipDns] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const data = check.data;
  const blockers = data?.blockers ?? [];
  const http01 = data?.request.challenge === "http01";
  // Names the console sees elsewhere (split DNS, a proxy in front) may still reach the nodes.
  const blocking = blockers.filter((b) => !(skipDns && http01 && b.code === "dns_not_pointing"));
  const run = async (action: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await action();
      await client.invalidateQueries();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  };
  const enable = (data: HttpsCheck) =>
    run(() =>
      request.mutateAsync({
        name: data.request.name.slice(0, 100),
        names: data.request.names,
        email: (email ?? data.request.email).trim(),
        ca,
        challenge: data.request.challenge,
        ...(data.request.dnsCredentialId ? { dnsCredentialId: data.request.dnsCredentialId } : {}),
        ...eabParams(ca, eab),
        ...(data.request.challenge === "http01" && skipDns ? { skipDnsCheck: true } : {}),
        autoRenew: true,
        bindSiteId: site.id,
      }),
    );
  const chosen = existing ?? data?.certificates[0]?.id ?? "";
  return (
    <Card className="animate-enter" data-testid="https-enable">
      <CardHeader>
        <CardTitle>{m.https_off()}</CardTitle>
      </CardHeader>
      <Collapsible
        open={customize}
        onOpenChange={setCustomize}
        className="flex flex-col gap-(--card-spacing)"
      >
        <CardContent className="grid gap-4">
          <p className="text-sm break-words text-muted-foreground">
            {site.domains.map(displaySiteDomain).join(", ")}
          </p>
          {check.isLoadingError ? (
            <ErrorState error={check.error} onRetry={() => void check.refetch()} />
          ) : blockers.length ? (
            <ul className="grid gap-2" data-testid="https-blockers">
              {blockers.map((blocker, index) => (
                <li
                  key={JSON.stringify(blocker)}
                  className="flex items-start gap-2 text-sm animate-enter"
                  style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
                >
                  <HugeiconsIcon
                    icon={Alert02Icon}
                    strokeWidth={2}
                    className="mt-0.5 size-4 shrink-0 text-destructive"
                  />
                  <span className="min-w-0 flex-1 break-words">
                    {httpsBlockerText(blocker, caLabel(ca))}
                  </span>
                  {blocker.code === "dns_credential_missing" ? (
                    <Button size="xs" variant="outline" onClick={() => addCredential.show()}>
                      {m.cert_dns_add()}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          <CollapsibleContent className="grid gap-4 sm:grid-cols-2">
            <AcmeCaFields
              idPrefix="https"
              ca={ca}
              onCaChange={setCa}
              eab={eab}
              onEabChange={setEab}
              settings={settings.data}
            />
            <Field>
              <FieldLabel htmlFor="httpsEmail">{m.cert_email()}</FieldLabel>
              <Input
                id="httpsEmail"
                type="email"
                autoComplete="email"
                value={email ?? data?.request.email ?? ""}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            {http01 ? (
              <SwitchField
                id="httpsSkipDns"
                label={m.cert_skip_dns_check()}
                checked={skipDns}
                onCheckedChange={setSkipDns}
              />
            ) : null}
          </CollapsibleContent>
          {data?.certificates.length ? (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-48 flex-1">
                <FormSelect
                  id="httpsExisting"
                  label={m.https_existing()}
                  value={chosen}
                  onChange={setExisting}
                  options={data.certificates.map((c) => ({ value: c.id, label: c.name }))}
                />
              </div>
              <Button
                variant="outline"
                disabled={pending || !chosen}
                data-testid="https-use-existing"
                onClick={() =>
                  run(() =>
                    update.mutateAsync({
                      id: site.id,
                      settings: { ...current, certificateId: chosen },
                    }),
                  )
                }
              >
                {m.https_use()}
              </Button>
            </div>
          ) : null}
        </CardContent>
        <CardFooter className="flex-wrap justify-end gap-2">
          {error ? (
            <FieldError className="mr-auto animate-in fade-in" data-testid="https-error">
              {error}
            </FieldError>
          ) : null}
          <CollapsibleTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                className="text-muted-foreground"
                data-testid="https-customize"
              />
            }
          >
            {m.https_customize()}
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              strokeWidth={2}
              className={cn(
                "transition-transform motion-reduce:transition-none",
                customize && "rotate-180",
              )}
            />
          </CollapsibleTrigger>
          {blockers.length ? (
            <Button
              variant="outline"
              disabled={check.isFetching}
              onClick={() => void check.refetch()}
            >
              {m.https_recheck()}
            </Button>
          ) : null}
          <Button
            disabled={
              !data || blocking.length > 0 || pending || check.isFetching || eabMissing(ca, eab)
            }
            data-testid="https-enable-submit"
            onClick={() => data && enable(data)}
          >
            {pending || check.isFetching ? <Spinner /> : null}
            {m.https_enable()}
          </Button>
        </CardFooter>
      </Collapsible>
      <DnsCredentialDialog
        key={addCredential.key}
        scope="credential"
        open={addCredential.open}
        onOpenChange={addCredential.onOpenChange}
        onSaved={async () => {
          await client.invalidateQueries();
        }}
      />
    </Card>
  );
}

/** What to check when the settings fail the contract, by the first issue's field. */
function settingsError(field: PropertyKey | undefined): string {
  if (field === "hstsMaxAge") return m.common_check_field({ field: m.cert_hsts_age() });
  if (field === "clientCertificate") return m.common_check_field({ field: m.https_client_ca() });
  if (field === "additionalCertificateIds")
    return m.common_check_field({ field: m.https_certificates() });
  return m.error_bad_request();
}

/** The HTTPS fields of `settings` (the compression card owns the rest). */
const httpsOf = (settings: TlsSettings) =>
  Object.fromEntries(
    Object.entries(settings).filter(
      ([key]) => !COMPRESSION_KEYS.includes(key as keyof TlsSettings),
    ),
  );

function HttpsEditor({
  site,
  initial,
  certificates,
}: {
  site: Site;
  initial: TlsSettings;
  certificates: CertificateDto[];
}) {
  const [settings, setSettings] = React.useState(initial);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const mutation = useMutation(orpc.https.update.mutationOptions());
  const client = useQueryClient();
  const features = useQuery(orpc.sites.features.queryOptions({ input: { id: site.id } }));
  const redirectAvailable = features.data?.edgePorts.available ?? true;
  const multiAvailable = features.data?.multiCertificate.available ?? true;
  const clientAvailable = features.data?.clientCertificate.available ?? true;
  const clientCert = settings.clientCertificate;
  const setClient = (change: Partial<TlsSettings["clientCertificate"]>) =>
    setSettings((old) => ({ ...old, clientCertificate: { ...old.clientCertificate, ...change } }));
  // Certificates the site may get: usable ones, and those it has already.
  const offered = certificates.filter(
    (c) =>
      c.id === initial.certificateId ||
      initial.additionalCertificateIds.includes(c.id) ||
      usable(c),
  );
  const chosen = [settings.certificateId, ...settings.additionalCertificateIds];
  const optionsFor = (current: string | null) =>
    offered
      .filter((c) => c.id === current || !chosen.includes(c.id))
      .map((c) => ({ value: c.id, label: c.name }));
  const canAdd =
    !!settings.certificateId &&
    settings.additionalCertificateIds.length < MAX_SITE_CERTIFICATES - 1 &&
    optionsFor(null).length > 0;
  // The redirect leaves host names alone: exact and `*.` domains, not suffixes or patterns.
  const hostDomains = site.domains.filter((domain) => {
    const kind = siteDomainKind(domain);
    return kind === "exact" || kind === "wildcard";
  });
  // Force HTTPS comes first, with its redirect settings under it; then the other switches.
  const flags = [
    ["http2", m.cert_http2()],
    ["http3", m.cert_http3()],
    ["hstsIncludeSubdomains", m.cert_hsts_subdomains()],
    ["hstsPreload", m.cert_hsts_preload()],
    ["ocspStapling", m.cert_ocsp()],
  ] as const;
  return (
    <Card className="animate-enter" style={{ animationDelay: "60ms" }}>
      <form
        className="flex flex-col gap-(--card-spacing)"
        onSubmit={async (event) => {
          event.preventDefault();
          // Compression as saved: the cache tab owns it.
          const parsed = tlsSettings.safeParse({ ...settings, ...compressionOf(initial) });
          if (!parsed.success) {
            setError(settingsError(parsed.error.issues[0]?.path[0]));
            return;
          }
          setPending(true);
          setError(null);
          try {
            await mutation.mutateAsync({ id: site.id, settings: parsed.data });
            await client.invalidateQueries();
            toast.success(m.common_saved());
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setPending(false);
          }
        }}
      >
        <CardHeader>
          <CardTitle>{m.site_tab_https()}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          <FormSelect
            id="siteCertificate"
            label={m.cert_title()}
            value={settings.certificateId ?? "none"}
            options={[
              { value: "none", label: m.cert_none() },
              ...optionsFor(settings.certificateId),
            ]}
            onChange={(value) =>
              setSettings((old) =>
                value === "none"
                  ? {
                      ...old,
                      certificateId: null,
                      additionalCertificateIds: [],
                      forceHttps: false,
                      hstsMaxAge: 0,
                      clientCertificate: { ...old.clientCertificate, mode: "off" },
                    }
                  : { ...old, certificateId: value },
              )
            }
          />
          {settings.additionalCertificateIds.map((id, index) => (
            <div key={id} className="flex items-end gap-2 animate-enter">
              <div className="min-w-0 flex-1">
                <FormSelect
                  id={`siteCertificate${index + 2}`}
                  label={m.https_certificate_n({ n: index + 2 })}
                  value={id}
                  options={optionsFor(id)}
                  onChange={(value) =>
                    setSettings((old) => ({
                      ...old,
                      additionalCertificateIds: old.additionalCertificateIds.map((other, i) =>
                        i === index ? value : other,
                      ),
                    }))
                  }
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={m.https_certificate_remove()}
                data-testid={`https-certificate-remove-${index + 2}`}
                onClick={() =>
                  setSettings((old) => ({
                    ...old,
                    additionalCertificateIds: old.additionalCertificateIds.filter(
                      (_, i) => i !== index,
                    ),
                  }))
                }
              >
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </Button>
            </div>
          ))}
          {canAdd ? (
            <div className="flex flex-col gap-2 self-end sm:col-span-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                disabled={!multiAvailable}
                data-testid="https-certificate-add"
                onClick={() =>
                  setSettings((old) => ({
                    ...old,
                    additionalCertificateIds: [
                      ...old.additionalCertificateIds,
                      optionsFor(null)[0]?.value ?? "",
                    ],
                  }))
                }
              >
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                {m.https_certificate_add()}
              </Button>
              {multiAvailable ? null : (
                <SafetyNote data-testid="https-certificates-unavailable">
                  {m.feature_unavailable_nodes()}
                </SafetyNote>
              )}
            </div>
          ) : null}
          <FormSelect
            id="minimumTls"
            label={m.cert_min_tls()}
            value={settings.minimumVersion}
            onChange={(value) =>
              setSettings({ ...settings, minimumVersion: value as "1.2" | "1.3" })
            }
            options={[
              { value: "1.2", label: m.cert_tls12() },
              { value: "1.3", label: m.cert_tls13() },
            ]}
          />
          <FormSelect
            id="cipherProfile"
            label={m.cert_ciphers()}
            value={settings.cipherProfile}
            onChange={(value) =>
              setSettings({ ...settings, cipherProfile: value as "modern" | "compatible" })
            }
            options={[
              { value: "modern", label: m.cert_modern() },
              { value: "compatible", label: m.cert_compatible() },
            ]}
          />
          <NumberField
            id="hstsAge"
            label={m.cert_hsts_age()}
            value={String(settings.hstsMaxAge)}
            min={0}
            max={63072000}
            disabled={!settings.certificateId}
            onChange={(value) => setSettings({ ...settings, hstsMaxAge: Number(value) })}
          />
          <SwitchField
            id="forceHttps"
            label={m.cert_force_https()}
            checked={settings.forceHttps}
            disabled={!settings.certificateId}
            onCheckedChange={(forceHttps) => setSettings({ ...settings, forceHttps })}
          />
          {settings.forceHttps ? (
            // The redirect's settings sit right under the force HTTPS switch (in the reading order
            // too), marked by a rule beside them; the other switches follow.
            <div
              className="grid gap-4 border-l-2 border-border pl-3 animate-enter sm:col-span-2 sm:grid-cols-2"
              data-testid="https-redirect"
            >
              <FormSelect
                id="redirectStatus"
                label={m.https_redirect_status()}
                value={String(settings.redirectStatus)}
                disabled={!redirectAvailable}
                options={HTTPS_REDIRECT_STATUSES.map((status) => ({
                  value: String(status),
                  label: String(status),
                }))}
                onChange={(value) =>
                  setSettings({
                    ...settings,
                    redirectStatus: Number(value) as TlsSettings["redirectStatus"],
                  })
                }
              />
              {/* A port is a machine value: monospace, like the site's ports. */}
              <Field>
                <FieldLabel htmlFor="redirectPort">{m.https_redirect_port()}</FieldLabel>
                <OptionSelect
                  id="redirectPort"
                  className="w-full font-mono"
                  value={String(settings.redirectPort)}
                  disabled={!redirectAvailable}
                  options={[...new Set([443, ...site.ports.https])].map((port) => ({
                    value: String(port),
                    label: String(port),
                  }))}
                  onChange={(value) => setSettings({ ...settings, redirectPort: Number(value) })}
                />
              </Field>
              {hostDomains.length > 1 ? (
                <div className="sm:col-span-2">
                  <CheckboxList
                    id="redirect-excluded"
                    legend={m.https_redirect_excluded()}
                    options={hostDomains.map((domain) => ({
                      value: domain,
                      label: displaySiteDomain(domain),
                    }))}
                    value={settings.redirectExcludedDomains}
                    disabled={!redirectAvailable}
                    onChange={(redirectExcludedDomains) =>
                      setSettings({
                        ...settings,
                        redirectExcludedDomains: [...redirectExcludedDomains].sort(),
                      })
                    }
                    testId="https-redirect-excluded"
                  />
                </div>
              ) : null}
              {redirectAvailable ? null : (
                <SafetyNote className="sm:col-span-2" data-testid="https-redirect-unavailable">
                  {m.feature_unavailable_nodes()}
                </SafetyNote>
              )}
            </div>
          ) : null}
          {flags.map(([key, label]) => (
            <SwitchField
              key={key}
              id={key}
              label={label}
              checked={settings[key]}
              // HTTP/3 and client certificates exclude each other.
              disabled={key === "http3" && clientCert.mode !== "off" && !settings.http3}
              onCheckedChange={(value) => setSettings({ ...settings, [key]: value })}
            />
          ))}
          <div
            className="grid gap-4 border-t pt-5 sm:col-span-2 sm:grid-cols-2"
            data-testid="https-client-cert"
          >
            <FormSelect
              id="clientCertMode"
              label={m.https_client_cert()}
              value={clientCert.mode}
              disabled={
                clientCert.mode === "off" &&
                (!settings.certificateId || !clientAvailable || settings.http3)
              }
              options={CLIENT_CERTIFICATE_MODES.map((mode) => ({
                value: mode,
                label: CLIENT_MODE_LABEL[mode](),
              }))}
              onChange={(mode) => setClient({ mode: mode as ClientCertificateMode })}
            />
            {clientCert.mode === "off" ? null : (
              <>
                <NumberField
                  id="clientCertDepth"
                  label={m.https_client_depth()}
                  value={String(clientCert.depth)}
                  min={CLIENT_CERTIFICATE_DEPTH_RANGE.min}
                  max={CLIENT_CERTIFICATE_DEPTH_RANGE.max}
                  onChange={(value) => setClient({ depth: Number(value) })}
                />
                <Field className="sm:col-span-2">
                  <FieldLabel htmlFor="clientCertCa">{m.https_client_ca()}</FieldLabel>
                  <Textarea
                    id="clientCertCa"
                    rows={6}
                    spellCheck={false}
                    autoComplete="off"
                    className="font-mono text-xs"
                    value={clientCert.caPem}
                    onChange={(event) => setClient({ caPem: event.target.value })}
                    data-testid="https-client-ca"
                  />
                </Field>
                <SwitchField
                  id="clientCertForward"
                  label={m.https_client_forward()}
                  checked={clientCert.forwardHeaders}
                  onCheckedChange={(forwardHeaders) => setClient({ forwardHeaders })}
                />
              </>
            )}
            {settings.http3 && clientCert.mode === "off" && settings.certificateId ? (
              <SafetyNote className="sm:col-span-2">{m.https_client_cert_http3()}</SafetyNote>
            ) : clientCert.mode === "off" && settings.certificateId && !clientAvailable ? (
              <SafetyNote className="sm:col-span-2" data-testid="https-client-cert-unavailable">
                {m.feature_unavailable_nodes()}
              </SafetyNote>
            ) : null}
          </div>
        </CardContent>
        <SaveBar
          dirty={JSON.stringify(httpsOf(settings)) !== JSON.stringify(httpsOf(initial))}
          pending={pending}
          error={error}
          testId="https-save"
        />
      </form>
    </Card>
  );
}
