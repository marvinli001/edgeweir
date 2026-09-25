import { Link } from "@tanstack/react-router";
import { useArea } from "@/lib/area";
import { m } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Segmented [Console | Admin] switch, shown to platform admins only. */
export function AreaSwitch() {
  const area = useArea();
  const item =
    "relative z-10 flex h-7 items-center justify-center rounded-full px-3 text-xs font-medium transition-colors duration-200 outline-none focus-visible:ring-3 focus-visible:ring-ring/30";
  return (
    <nav
      aria-label={m.area_switch()}
      className="relative grid grid-cols-2 rounded-full bg-muted p-0.5 shadow-inner ring-1 ring-foreground/5"
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-full bg-background shadow-sm ring-1 ring-foreground/10 transition-transform duration-300 ease-out motion-reduce:transition-none",
          area === "admin" && "translate-x-full",
        )}
      />
      <Link
        to="/"
        data-testid="area-console"
        aria-current={area === "console" ? "page" : undefined}
        className={cn(
          item,
          area === "console" ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {m.area_console()}
      </Link>
      <Link
        to="/admin"
        data-testid="area-admin"
        aria-current={area === "admin" ? "page" : undefined}
        className={cn(
          item,
          area === "admin" ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {m.area_admin()}
      </Link>
    </nav>
  );
}
