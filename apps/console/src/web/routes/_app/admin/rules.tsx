import { createFileRoute } from "@tanstack/react-router";
import { Page } from "@/components/page";
import { RulesTab } from "@/components/site/rules-tab";
import { m } from "@/lib/i18n";
export const Route = createFileRoute("/_app/admin/rules")({
  component: () => (
    <Page title={m.rules_platform()}>
      <RulesTab />
    </Page>
  ),
});
