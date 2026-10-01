import { useNavigate } from "@tanstack/react-router";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { m } from "@/lib/i18n";

/**
 * Websites and layer-4 applications are two lists of the sites section; the sidebar has one
 * entry for both (it fits an 800 px screen), and this switch leads from one list to the other.
 */
export function SitesTabs({ value }: { value: "sites" | "l4" }) {
  const navigate = useNavigate();
  return (
    <Tabs
      value={value}
      onValueChange={(next) => {
        if (next !== value) void navigate({ to: next === "l4" ? "/l4" : "/sites" });
      }}
    >
      <TabsList>
        <TabsTrigger value="sites" data-testid="sites-tab-sites">
          {m.nav_sites()}
        </TabsTrigger>
        <TabsTrigger value="l4" data-testid="sites-tab-l4">
          {m.l4_title()}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
