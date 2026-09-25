import { ArrowUpDownIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { toast } from "sonner";
import { Logo } from "@/components/logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { useArea } from "@/lib/area";
import { m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

/**
 * Sidebar header: the product mark, plus an organization switcher when the user belongs to more
 * than one organization.
 */
export function OrgSwitcher() {
  const area = useArea();
  const { isMobile } = useSidebar();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const me = useQuery(orpc.account.me.queryOptions());
  const switchOrg = useMutation(orpc.account.setActiveOrganization.mutationOptions());
  const organizations = me.data?.organizations ?? [];
  const active = me.data?.activeOrganization;

  if (area === "admin" || organizations.length < 2 || !active) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            className="data-[slot=sidebar-menu-button]:p-1.5!"
            render={<Link to={area === "admin" ? "/admin" : "/overview"} />}
          >
            <Logo className="size-5!" />
            <span className="text-base font-semibold">{m.app_name()}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                size="lg"
                className="aria-expanded:bg-muted"
                data-testid="org-switcher"
                aria-label={m.org_switch()}
              />
            }
          >
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm shadow-primary/20">
              <Logo className="size-4" />
            </span>
            <span className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-semibold" data-testid="active-org">
                {active.name}
              </span>
              <span className="truncate text-xs text-muted-foreground">{m.app_name()}</span>
            </span>
            {switchOrg.isPending ? (
              <Spinner className="ml-auto" />
            ) : (
              <HugeiconsIcon icon={ArrowUpDownIcon} strokeWidth={2} className="ml-auto size-4" />
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-56"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>{m.org_switch()}</DropdownMenuLabel>
              {organizations.map((org) => (
                <DropdownMenuItem
                  key={org.id}
                  data-testid={`org-${org.slug}`}
                  onClick={async () => {
                    if (org.id === active.id) return;
                    try {
                      await switchOrg.mutateAsync({ organizationId: org.id });
                      await queryClient.invalidateQueries();
                      if (pathname.startsWith("/sites/")) await navigate({ to: "/sites" });
                      toast.success(m.org_switched({ name: org.name }));
                    } catch (error) {
                      toast.error(errorMessage(error));
                    }
                  }}
                >
                  <span className="flex-1 truncate">{org.name}</span>
                  {org.id === active.id ? (
                    <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-4" />
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
