import { useNavigate } from "@tanstack/react-router";
import { Tabs, TabsList, TabsTrigger } from "@/components/arc/tabs/tabs";
import { m } from "@/lib/i18n";

type Tab = "ip-lists" | "bans" | "greylist";

/** IP lists, bans and the greylist are lists of one sidebar entry; this switch leads between them. */
export function AccessTabs({ value }: { value: Tab }) {
  const navigate = useNavigate();
  return (
    <Tabs
      value={value}
      onValueChange={(next) => {
        if (next !== value) void navigate({ to: `/${next as Tab}` });
      }}
    >
      <TabsList>
        <TabsTrigger value="ip-lists" data-testid="access-tab-ip-lists">
          {m.ip_lists_title()}
        </TabsTrigger>
        <TabsTrigger value="bans" data-testid="access-tab-bans">
          {m.bans_title()}
        </TabsTrigger>
        <TabsTrigger value="greylist" data-testid="access-tab-greylist">
          {m.greylist_title()}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
