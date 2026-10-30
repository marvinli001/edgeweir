import type { SiteExtensionView } from "@edgeweir/contract";
import { PuzzleIcon } from "@hugeicons/core-free-icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import {
  type ConfigDraft,
  configDraft,
  configFromDraft,
  hasConfigFields,
  localizedText,
  SchemaForm,
} from "@/components/extensions/schema-form";
import { FieldError, FieldGroup } from "@/components/layout/form";
import {
  Panel,
  PanelAction,
  PanelContent,
  PanelHeader,
  PanelTitle,
} from "@/components/layout/panel";
import { Spinner } from "@/components/layout/spinner";
import { LinkButton } from "@/components/link-button";
import { enterDelay } from "@/components/page";
import { SwitchField } from "@/components/site/fields";
import { EmptyState, QueryView } from "@/components/states";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

/** One installed extension on the site: on or off here, and the site's configuration. */
function SiteExtensionCard({
  siteId,
  extension,
  index,
}: {
  siteId: string;
  extension: SiteExtensionView;
  index: number;
}) {
  const [enabled, setEnabled] = React.useState(extension.enabled);
  const [draft, setDraft] = React.useState<ConfigDraft>(() =>
    configDraft(extension.schema, extension.config),
  );
  const [error, setError] = React.useState<string | null>(null);
  const update = useMutation({
    ...orpc.extensions.updateSite.mutationOptions(),
    meta: {
      invalidates: [orpc.extensions.key(), orpc.sites.key()],
      success: m.common_saved,
    },
  });
  const fields = hasConfigFields(extension.schema);
  return (
    <Panel
      className="animate-enter"
      style={enterDelay(index)}
      data-testid="site-extension"
      data-extension={extension.id}
    >
      <PanelHeader>
        <PanelTitle>
          <span className="truncate">{localizedText(extension.name, extension.id)}</span>
          <span className="font-mono text-xs font-normal text-muted-foreground">
            {extension.version}
          </span>
        </PanelTitle>
        {extension.installedEnabled ? null : (
          <PanelAction>
            <Badge size="sm" tone="neutral">
              {m.site_extension_off_everywhere()}
            </Badge>
          </PanelAction>
        )}
      </PanelHeader>
      <PanelContent>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            try {
              await update.mutateAsync({
                siteId,
                id: extension.id,
                enabled,
                config: configFromDraft(extension.schema, draft),
              });
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        >
          <FieldGroup>
            <SwitchField
              id={`site-extension-${extension.id}`}
              label={m.site_extension_enable()}
              checked={enabled}
              onCheckedChange={setEnabled}
              className="self-start"
              testId="site-extension-enabled"
            />
            {fields && enabled ? (
              <SchemaForm
                schema={extension.schema}
                draft={draft}
                onChange={setDraft}
                idPrefix={`site-extension-${extension.id}`}
              />
            ) : null}
            {error ? <FieldError className="animate-in fade-in">{error}</FieldError> : null}
            <Button
              type="submit"
              className="self-start"
              disabled={update.isPending}
              data-testid="site-extension-save"
            >
              {update.isPending ? <Spinner /> : null}
              {m.common_save()}
            </Button>
          </FieldGroup>
        </form>
      </PanelContent>
    </Panel>
  );
}

/** A site's Extensions tab: every installed extension, turned on and configured per site. */
export function ExtensionsTab({ siteId }: { siteId: string }) {
  const extensions = useQuery(orpc.extensions.forSite.queryOptions({ input: { siteId } }));
  return (
    <QueryView
      query={extensions}
      empty={
        <EmptyState icon={PuzzleIcon} title={m.extensions_empty()}>
          <LinkButton to="/system" search={{ tab: "extensions" }} variant="secondary">
            {m.extensions_install()}
          </LinkButton>
        </EmptyState>
      }
    >
      {(list) => (
        <div className="flex flex-col gap-6">
          {list.map((extension, index) => (
            <SiteExtensionCard
              key={`${extension.id}-${extension.updatedAt ?? ""}-${extension.version}`}
              siteId={siteId}
              extension={extension}
              index={index}
            />
          ))}
        </div>
      )}
    </QueryView>
  );
}
