import {
  type CertificateDto,
  certificateUnloadable,
  HTTPS_REDIRECT_STATUSES,
  type HttpsCheck,
  type Site,
  type TlsSettings,
  tlsSettings,
} from "@edgeweir/contract";
import { Alert02Icon, ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DnsCredentialDialog } from "@/components/dns/credential-dialog";
import { FormSelect } from "@/components/form-select";
import { SafetyNote } from "@/components/safety-note";
import { COMPRESSION_KEYS, compressionOf } from "@/components/site/compression-card";
import { NumberField, SwitchField } from "@/components/site/fields";
import { CheckboxList } from "@/components/site/ports-card";
import { SaveBar } from "@/components/site/save-site";
import { combineQueries, ErrorState, QueryView } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldError, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useDialogState } from "@/hooks/use-dialog-state";
import { certificateErrorText } from "@/lib/certificate-errors";
import { httpsBlockerText } from "@/lib/https-blockers";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

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

const caLabel = (ca: string) => (ca === "zerossl" ? m.cert_ca_zerossl() : m.cert_ca_letsencrypt());

/**
 * One click: a certificate for the site's domains, bound to it once issued.
 * The button waits for https.check; its blockers are listed instead.
 */
function EnableHttps({ site, current }: { site: Site; current: TlsSettings }) {
  const client = useQueryClient();
  const [ca, setCa] = React.useState<"letsencrypt" | "zerossl">("letsencrypt");
  // The DNS-01 check asks the provider: not again on every focus.
  const check = useQuery({
    ...orpc.https.check.queryOptions({ input: { id: site.id, ca } }),
    staleTime: 30_000,
  });
  const settings = useQuery(orpc.certificates.settings.queryOptions());
  const request = useMutation(orpc.certificates.request.mutationOptions());
  const update = useMutation(orpc.https.update.mutationOptions());
  const [email, setEmail] = React.useState<string | null>(null);
  const [eab, setEab] = React.useState({ kid: "", key: "" });
  const [existing, setExisting] = React.useState<string | null>(null);
  const addCredential = useDialogState();
  const [customize, setCustomize] = React.useState(false);
  const [skipDns, setSkipDns] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const acmeDirectory = settings.data?.acmeDirectory ?? null;
  const zerossl = ca === "zerossl" && !acmeDirectory;
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
        ca: acmeDirectory ? "letsencrypt" : ca,
        challenge: data.request.challenge,
        ...(data.request.dnsCredentialId ? { dnsCredentialId: data.request.dnsCredentialId } : {}),
        ...(zerossl ? { eabKid: eab.kid, eabHmacKey: eab.key } : {}),
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
          <p className="text-sm break-words text-muted-foreground">{site.domains.join(", ")}</p>
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
            {acmeDirectory ? (
              <Field>
                <FieldTitle>{m.cert_acme_directory()}</FieldTitle>
                <p className="font-mono text-sm break-all">{acmeDirectory}</p>
              </Field>
            ) : (
              <FormSelect
                id="httpsCa"
                label={m.cert_ca()}
                value={ca}
                onChange={(value) => setCa(value === "zerossl" ? "zerossl" : "letsencrypt")}
                options={[
                  { value: "letsencrypt", label: m.cert_ca_letsencrypt() },
                  { value: "zerossl", label: m.cert_ca_zerossl() },
                ]}
              />
            )}
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
            {zerossl ? (
              <>
                <Field>
                  <FieldLabel htmlFor="httpsEabKid">{m.cert_eab_kid()}</FieldLabel>
                  <Input
                    id="httpsEabKid"
                    autoComplete="off"
                    value={eab.kid}
                    onChange={(event) => setEab({ ...eab, kid: event.target.value })}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="httpsEabKey">{m.cert_eab_key()}</FieldLabel>
                  <Input
                    id="httpsEabKey"
                    type="password"
                    autoComplete="off"
                    value={eab.key}
                    onChange={(event) => setEab({ ...eab, key: event.target.value })}
                  />
                </Field>
              </>
            ) : null}
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
            disabled={!data || blocking.length > 0 || pending || check.isFetching}
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
  const flags = [
    ["forceHttps", m.cert_force_https()],
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
              ...certificates
                .filter((c) => c.id === initial.certificateId || usable(c))
                .map((c) => ({ value: c.id, label: c.name })),
            ]}
            onChange={(value) =>
              setSettings((old) =>
                value === "none"
                  ? { ...old, certificateId: null, forceHttps: false, hstsMaxAge: 0 }
                  : { ...old, certificateId: value },
              )
            }
          />
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
          {flags.map(([key, label]) => (
            <SwitchField
              key={key}
              id={key}
              label={label}
              checked={settings[key]}
              disabled={key === "forceHttps" && !settings.certificateId}
              onCheckedChange={(value) => setSettings({ ...settings, [key]: value })}
            />
          ))}
          {settings.forceHttps ? (
            <div className="grid gap-4 sm:col-span-2 sm:grid-cols-2" data-testid="https-redirect">
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
              <FormSelect
                id="redirectPort"
                label={m.https_redirect_port()}
                value={String(settings.redirectPort)}
                disabled={!redirectAvailable}
                options={[...new Set([443, ...site.ports.https])].map((port) => ({
                  value: String(port),
                  label: String(port),
                }))}
                onChange={(value) => setSettings({ ...settings, redirectPort: Number(value) })}
              />
              {site.domains.length > 1 ? (
                <div className="sm:col-span-2">
                  <CheckboxList
                    id="redirect-excluded"
                    legend={m.https_redirect_excluded()}
                    options={site.domains.map((domain) => ({ value: domain, label: domain }))}
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
