import { useNavigate } from "@tanstack/react-router";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { m } from "@/lib/i18n";

/** IP lists and bans are two lists of one sidebar entry; this switch leads from one to the other. */
export function AccessTabs({ value }: { value: "ip-lists" | "bans" }) {
  const navigate = useNavigate();
  return (
    <Tabs
      value={value}
      onValueChange={(next) => {
        if (next !== value) void navigate({ to: next === "bans" ? "/bans" : "/ip-lists" });
      }}
    >
      <TabsList>
        <TabsTrigger value="ip-lists" data-testid="access-tab-ip-lists">
          {m.ip_lists_title()}
        </TabsTrigger>
        <TabsTrigger value="bans" data-testid="access-tab-bans">
          {m.bans_title()}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
