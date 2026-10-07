import {
  CHARSETS,
  type ContentSettings,
  MAX_REQUEST_BODY_LIMIT,
  purgeKey,
  type Site,
} from "@edgeweir/contract";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { CopyButton } from "@/components/copy-button";
import { FormSelect, type Option } from "@/components/form-select";
import { SafetyNote } from "@/components/safety-note";
import { NumberField, SwitchField } from "@/components/site/fields";
import { SaveBar, useSaveSite } from "@/components/site/save-site";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { localizeError } from "@/lib/errors";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

/** Whether the cluster's nodes run site-content-v1 (true while unknown). */
function useSiteContent(siteId: string) {
  const features = useQuery(orpc.sites.features.queryOptions({ input: { id: siteId } }));
  return features.data?.siteContent.available !== false;
}

/** A random PURGE key: 32 bytes, base64url. */
function generateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/**
 * The PURGE method: `PURGE <URL>` with the key in X-Purge-Key purges the URL on every
 * node. The key is write-only; a saved one stays when the field is left empty.
 */
export function PurgeMethodCard({ site }: { site: Site }) {
  const saved = site.cacheSettings.purgeMethod;
  const available = useSiteContent(site.id);
  const [enabled, setEnabled] = React.useState(saved.enabled);
  const [key, setKey] = React.useState("");
  const [generated, setGenerated] = React.useState(false);
  const [invalid, setInvalid] = React.useState<string | null>(null);
  const { save, error, pending } = useSaveSite(site.id);
  const blocked = !available && !saved.enabled;
  const dirty = enabled !== saved.enabled || key !== "";
  return (
    <Card
      className="animate-enter"
      style={{ animationDelay: "100ms" }}
      data-testid="purge-method-card"
    >
      <form
        className="flex flex-col gap-(--card-spacing)"
        onSubmit={async (event) => {
          event.preventDefault();
          const checked = key ? purgeKey.safeParse(key) : null;
          setInvalid(checked && !checked.success ? localizeError(checked.error) : null);
          if (checked && !checked.success) return;
          const ok = await save({
            cacheSettings: {
              ...site.cacheSettings,
              purgeMethod: { enabled, ...(key ? { key } : {}) },
            },
          });
          if (ok) {
            setKey("");
            setGenerated(false);
          }
        }}
      >
        <CardHeader>
          <CardTitle>{m.site_purge_method_title()}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {blocked ? (
            <SafetyNote data-testid="purge-method-unavailable">
              {m.feature_unavailable_nodes()}
            </SafetyNote>
          ) : null}
          <SwitchField
            id="purge-method-enabled"
            label={m.site_purge_method_enabled()}
            checked={enabled}
            disabled={blocked}
            onCheckedChange={setEnabled}
            className="self-start"
            testId="purge-method-enabled"
          />
          <Field data-disabled={blocked || undefined}>
            <FieldLabel htmlFor="purge-method-key">{m.site_purge_method_key()}</FieldLabel>
            <div className="flex min-w-0 gap-2">
              <Input
                id="purge-method-key"
                value={key}
                autoComplete="off"
                spellCheck={false}
                disabled={blocked}
                placeholder={saved.keySet ? m.site_secret_saved() : undefined}
                onChange={(event) => {
                  setKey(event.target.value);
                  setGenerated(false);
                }}
                className="min-w-0 font-mono text-sm"
                data-testid="purge-method-key"
              />
              {generated ? <CopyButton value={key} /> : null}
              <Button
                type="button"
                variant="outline"
                disabled={blocked}
                onClick={() => {
                  setKey(generateKey());
                  setGenerated(true);
                }}
                data-testid="purge-method-generate"
              >
                {m.site_purge_method_generate()}
              </Button>
            </div>
          </Field>
          {generated ? (
            <SafetyNote className="animate-in fade-in" data-testid="purge-method-generated">
              {m.site_purge_method_generated()}
            </SafetyNote>
          ) : null}
        </CardContent>
        <SaveBar
          dirty={dirty}
          pending={pending}
          error={invalid ?? error}
          testId="purge-method-save"
        />
      </form>
    </Card>
  );
}

/** Whether visitors get the X-Cache response header. */
export function XCacheCard({ site }: { site: Site }) {
  const saved = site.cacheSettings.xCache;
  const available = useSiteContent(site.id);
  const [send, setSend] = React.useState(saved);
  const { save, error, pending } = useSaveSite(site.id);
  // Hiding it waits for site-content-v1; sending it again never does.
  const blocked = !available && saved;
  return (
    <Card className="animate-enter" style={{ animationDelay: "180ms" }} data-testid="x-cache-card">
      <form
        className="flex flex-col gap-(--card-spacing)"
        onSubmit={(event) => {
          event.preventDefault();
          void save({ cacheSettings: { ...site.cacheSettings, xCache: send } });
        }}
      >
        <CardHeader>
          <CardTitle>{m.site_x_cache_title()}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {blocked ? (
            <SafetyNote data-testid="x-cache-unavailable">
              {m.feature_unavailable_nodes()}
            </SafetyNote>
          ) : null}
          <SwitchField
            id="x-cache-send"
            label={m.site_x_cache_send()}
            checked={send}
            disabled={blocked}
            onCheckedChange={setSend}
            className="self-start"
            testId="x-cache-send"
          />
        </CardContent>
        <SaveBar dirty={send !== saved} pending={pending} error={error} testId="x-cache-save" />
      </form>
    </Card>
  );
}

type Charset = ContentSettings["charset"];

/** The charset added to text responses. */
export function CharsetCard({ site }: { site: Site }) {
  const saved = site.contentSettings.charset;
  const available = useSiteContent(site.id);
  const [charset, setCharset] = React.useState<Charset>(saved);
  const { save, error, pending } = useSaveSite(site.id);
  const blocked = !available && saved.name === "off";
  const off = charset.name === "off";
  const options: Option<Charset["name"]>[] = [
    { value: "off", label: m.site_charset_off() },
    ...CHARSETS.map((name) => ({ value: name, label: name })),
  ];
  return (
    <Card className="animate-enter" style={{ animationDelay: "220ms" }} data-testid="charset-card">
      <form
        className="flex flex-col gap-(--card-spacing)"
        onSubmit={(event) => {
          event.preventDefault();
          void save({ contentSettings: { ...site.contentSettings, charset } });
        }}
      >
        <CardHeader>
          <CardTitle>{m.site_charset_title()}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {blocked ? (
            <SafetyNote data-testid="charset-unavailable">
              {m.feature_unavailable_nodes()}
            </SafetyNote>
          ) : null}
          {/* The switches keep to the select's side instead of spreading across the card. */}
          <div className="grid gap-4 sm:grid-cols-[12rem_auto_auto] sm:items-end sm:justify-start sm:gap-x-6">
            <FormSelect
              id="charset-name"
              label={m.site_charset_name()}
              value={charset.name}
              options={options}
              disabled={blocked}
              onChange={(name) => setCharset({ ...charset, name })}
              testId="charset-name"
            />
            <SwitchField
              id="charset-force"
              label={m.site_charset_force()}
              checked={charset.force}
              disabled={blocked || off}
              onCheckedChange={(force) => setCharset({ ...charset, force })}
              testId="charset-force"
            />
            <SwitchField
              id="charset-uppercase"
              label={m.site_charset_uppercase()}
              checked={charset.uppercase}
              disabled={blocked || off}
              onCheckedChange={(uppercase) => setCharset({ ...charset, uppercase })}
              testId="charset-uppercase"
            />
          </div>
        </CardContent>
        <SaveBar
          dirty={JSON.stringify(charset) !== JSON.stringify(saved)}
          pending={pending}
          error={error}
          testId="charset-save"
        />
      </form>
    </Card>
  );
}

const MIB = 1024 * 1024;
const DEFAULT_LIMIT = 100 * MIB;

/** The largest request body (by Content-Length) the site accepts; 0 means no limit. */
export function BodyLimitCard({ site }: { site: Site }) {
  const saved = site.contentSettings.requestBodyLimit;
  const available = useSiteContent(site.id);
  // Six decimals keep byte-sized limits (1 KiB is 0.000977 MiB) from rounding to 0.
  const toMib = (bytes: number) => String(Number((bytes / MIB).toFixed(6)));
  const [value, setValue] = React.useState(toMib(saved));
  const { save, error, pending } = useSaveSite(site.id);
  const bytes = Math.round(Number(value) * MIB);
  const valid =
    value.trim() !== "" && Number.isFinite(bytes) && bytes >= 0 && bytes <= MAX_REQUEST_BODY_LIMIT;
  // Another limit than the default waits for site-content-v1 (a saved one stays editable).
  const blocked = !available && saved === DEFAULT_LIMIT;
  return (
    <Card
      className="animate-enter"
      style={{ animationDelay: "160ms" }}
      data-testid="body-limit-card"
    >
      <form
        className="flex flex-col gap-(--card-spacing)"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid)
            void save({ contentSettings: { ...site.contentSettings, requestBodyLimit: bytes } });
        }}
      >
        <CardHeader>
          <CardTitle>{m.site_body_limit_title()}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {blocked ? (
            <SafetyNote data-testid="body-limit-unavailable">
              {m.feature_unavailable_nodes()}
            </SafetyNote>
          ) : null}
          <div className="w-full sm:w-56">
            <NumberField
              id="body-limit"
              label={m.site_body_limit_value()}
              value={value}
              min={0}
              max={MAX_REQUEST_BODY_LIMIT / MIB}
              step="any"
              required
              disabled={blocked}
              placeholder={m.compression_no_limit()}
              onChange={setValue}
              testId="body-limit"
            />
          </div>
          <SafetyNote>{m.site_body_limit_note()}</SafetyNote>
        </CardContent>
        <SaveBar
          dirty={valid && bytes !== saved}
          pending={pending}
          error={error}
          testId="body-limit-save"
        />
      </form>
    </Card>
  );
}
