import type { Site } from "@edgeweir/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { FormDialog } from "@/components/form-dialog";
import { SafetyNote } from "@/components/safety-note";
import { followSiteDelivery } from "@/components/site/delivery-toast";
import { TagPicker } from "@/components/site-tags";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { domainList } from "@/lib/address-input";
import { m } from "@/lib/i18n";
import { client, orpc } from "@/lib/orpc";

/** A new site with the source's settings, origins and tags: its own name and domains. */
export function CloneSiteDialog({
  open,
  onOpenChange,
  site,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  site: Site;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [domains, setDomains] = React.useState("");
  const [tags, setTags] = React.useState<string[]>(() => site.tags.map((tag) => tag.name));
  const first = domainList(domains)[0] ?? "";
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.clone_title({ name: site.name })}
      submitLabel={m.clone_submit()}
      submitTestId="clone-submit"
      onSubmit={async (data) => {
        const name = String(data.get("cloneName") ?? "").trim();
        const result = await client.sites.clone({
          id: site.id,
          name: name || undefined,
          domains: domainList(domains),
          tags,
        });
        followSiteDelivery(queryClient, result.site.id, m.clone_done_toast(), result.site.delivery);
        onOpenChange(false);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.sites.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.siteTags.key() }),
        ]);
        await navigate({ to: "/sites/$id", params: { id: result.site.id } });
      }}
    >
      <SafetyNote>{m.clone_note()}</SafetyNote>
      <Field>
        <FieldLabel htmlFor="cloneName">{m.site_form_name()}</FieldLabel>
        <Input
          id="cloneName"
          name="cloneName"
          maxLength={100}
          placeholder={first || site.name}
          data-testid="clone-name"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="cloneDomains">{m.site_form_domains()}</FieldLabel>
        <Textarea
          id="cloneDomains"
          required
          rows={2}
          value={domains}
          onChange={(event) => setDomains(event.target.value)}
          placeholder="demo.test"
          data-testid="clone-domains"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="clone-tags">{m.tags_label()}</FieldLabel>
        <TagPicker id="clone-tags" value={tags} onChange={setTags} testId="clone-tags" />
      </Field>
    </FormDialog>
  );
}
