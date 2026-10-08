import { type AcmeCa, type CertificateSettings, EAB_REQUIRED_CAS } from "@edgeweir/contract";
import { FormSelect } from "@/components/form-select";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { m } from "@/lib/i18n";

/** A certificate authority's name. */
export const caLabel = (ca: string) =>
  ca === "zerossl"
    ? m.cert_ca_zerossl()
    : ca === "google"
      ? m.cert_ca_google()
      : ca === "custom"
        ? m.cert_ca_custom()
        : m.cert_ca_letsencrypt();

/** The CAs a request can choose: the built-in ones, and the custom directory once configured. */
export function caOptions(settings: CertificateSettings | undefined) {
  const cas: AcmeCa[] = ["letsencrypt", "zerossl", "google"];
  if (settings?.acmeDirectory) cas.push("custom");
  return cas.map((value) => ({ value, label: caLabel(value) }));
}

export interface Eab {
  kid: string;
  key: string;
}

/** The request's EAB fields: both or none (the custom directory may bring its own). */
export const eabParams = (ca: AcmeCa, eab: Eab) =>
  ca !== "letsencrypt" && eab.kid.trim() && eab.key.trim()
    ? { eabKid: eab.kid.trim(), eabHmacKey: eab.key.trim() }
    : {};

/** Whether the request still misses EAB: ZeroSSL and Google Trust Services require it. */
export const eabMissing = (ca: AcmeCa, eab: Eab) =>
  (EAB_REQUIRED_CAS.includes(ca) && (!eab.kid.trim() || !eab.key.trim())) ||
  !eab.kid.trim() !== !eab.key.trim();

/**
 * The CA select and the EAB key ID and HMAC key: ZeroSSL and Google Trust
 * Services require them; the custom directory uses its own from the system
 * settings unless they are filled in.
 */
export function AcmeCaFields({
  idPrefix,
  ca,
  onCaChange,
  eab,
  onEabChange,
  settings,
}: {
  idPrefix: string;
  ca: AcmeCa;
  onCaChange: (ca: AcmeCa) => void;
  eab: Eab;
  onEabChange: (eab: Eab) => void;
  settings: CertificateSettings | undefined;
}) {
  const required = EAB_REQUIRED_CAS.includes(ca);
  const fromSettings = ca === "custom" && settings?.acmeDirectoryEab;
  return (
    <>
      <FormSelect
        id={`${idPrefix}Ca`}
        label={m.cert_ca()}
        value={ca}
        onChange={(value) => onCaChange(value as AcmeCa)}
        options={caOptions(settings)}
      />
      {ca === "custom" && settings?.acmeDirectory ? (
        <p
          className="self-end font-mono text-xs leading-5 break-all text-muted-foreground"
          data-testid={`${idPrefix}-acme-directory`}
        >
          {settings.acmeDirectory}
        </p>
      ) : null}
      {ca === "letsencrypt" ? null : (
        <>
          <Field>
            <FieldLabel htmlFor={`${idPrefix}EabKid`}>{m.cert_eab_kid()}</FieldLabel>
            <Input
              id={`${idPrefix}EabKid`}
              autoComplete="off"
              required={required}
              value={eab.kid}
              placeholder={fromSettings ? m.cert_eab_from_settings() : undefined}
              onChange={(event) => onEabChange({ ...eab, kid: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${idPrefix}EabKey`}>{m.cert_eab_key()}</FieldLabel>
            <Input
              id={`${idPrefix}EabKey`}
              type="password"
              autoComplete="off"
              required={required}
              value={eab.key}
              placeholder={fromSettings ? m.cert_eab_from_settings() : undefined}
              onChange={(event) => onEabChange({ ...eab, key: event.target.value })}
            />
          </Field>
        </>
      )}
    </>
  );
}
