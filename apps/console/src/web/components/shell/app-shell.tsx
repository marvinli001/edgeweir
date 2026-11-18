import { useRouter } from "@tanstack/react-router";
import * as React from "react";
import { Drawer, DrawerContent } from "@/components/arc/drawer/drawer";
import { m } from "@/lib/i18n";
import { NavList, SideNav } from "./side-nav";
import { useCurrentSidebarScope } from "./sidebar-scope";
import { type ShellUser, TopBar } from "./top-bar";

const RAIL_KEY = "edgeweir.sidebar-rail";

function readRail() {
  try {
    return localStorage.getItem(RAIL_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The console frame (tokens.md): the top bar over a sidebar and the gray canvas. The sidebar folds
 * into an icon rail (remembered per browser); on phones it is a drawer from the left.
 */
export function AppShell({ user, children }: { user: ShellUser; children: React.ReactNode }) {
  const [rail, setRail] = React.useState(readRail);
  const [menu, setMenu] = React.useState(false);
  const router = useRouter();
  const scope = useCurrentSidebarScope();
  // Keep the drawer open if the operator cancels the navigation.
  React.useEffect(
    () =>
      router.subscribe("onResolved", (event) => {
        if (event.hrefChanged) setMenu(false);
      }),
    [router],
  );
  const changeRail = (next: boolean) => {
    setRail(next);
    try {
      localStorage.setItem(RAIL_KEY, next ? "1" : "0");
    } catch {
      // Private mode: the choice lasts for this page only.
    }
  };
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <TopBar user={user} onMenu={() => setMenu(true)} />
      <div className="flex min-h-0 flex-1">
        <SideNav rail={rail} onRailChange={changeRail} />
        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      </div>
      <Drawer open={menu} onOpenChange={setMenu}>
        <DrawerContent
          title={m.app_name()}
          side="left"
          className={
            scope
              ? "w-[calc(100vw-12px)]! max-w-[30rem] border-y border-r md:hidden [&>div:first-child]:min-h-[70px] [&>div:first-child]:px-5 [&>div:first-child_button]:border [&>div:first-child_button]:border-border [&>div:nth-child(2)]:p-5"
              : "w-72! md:hidden"
          }
        >
          {/* A tap on the current page's entry closes the drawer too (no navigation follows). */}
          <div
            className={scope ? "flex h-full flex-col" : "-m-4 flex h-full flex-col"}
            onClickCapture={(event) => {
              if ((event.target as HTMLElement).closest('a[aria-current="page"]')) {
                setMenu(false);
              }
            }}
          >
            <NavList drawer />
          </div>
        </DrawerContent>
      </Drawer>
    </div>
  );
}
