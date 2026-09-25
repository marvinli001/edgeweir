import type { LandingPage } from "@edgeweir/contract";
import {
  Analytics01Icon,
  ApiIcon,
  FlashIcon,
  GitBranchIcon,
  GlobalIcon,
  RefreshIcon,
  SecurityCheckIcon,
  SquareLock02Icon,
} from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { getLocale, type Locale, localeLabels, m, setLocale } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import "./landing.css";

export interface LandingProps {
  page: LandingPage;
  /** The visitor has a console session: sign-in and sign-up turn into one console button. */
  signedIn: boolean;
}

export function headline(page: LandingPage): string {
  return page.settings.headline || m.landing_default_headline();
}

export function description(page: LandingPage): string {
  return (
    page.settings.description || m.landing_default_description({ brand: page.settings.brandName })
  );
}

/** Brand title and description in the document head while the landing page is shown. */
export function useLandingHead(page: LandingPage) {
  const title = page.settings.headline
    ? `${page.settings.headline} | ${page.settings.brandName}`
    : page.settings.brandName;
  const text = description(page);
  React.useEffect(() => {
    const previous = document.title;
    document.title = title;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const created = !meta;
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "description";
      document.head.append(meta);
    }
    const previousText = meta.content;
    meta.content = text;
    return () => {
      document.title = previous;
      if (created) meta.remove();
      else meta.content = previousText;
    };
  }, [title, text]);
}

export const features = [
  {
    id: "cache",
    icon: FlashIcon,
    title: m.landing_feature_cache_title,
    text: m.landing_feature_cache_text,
  },
  {
    id: "purge",
    icon: RefreshIcon,
    title: m.landing_feature_purge_title,
    text: m.landing_feature_purge_text,
  },
  {
    id: "security",
    icon: SecurityCheckIcon,
    title: m.landing_feature_security_title,
    text: m.landing_feature_security_text,
  },
  {
    id: "tls",
    icon: SquareLock02Icon,
    title: m.landing_feature_tls_title,
    text: m.landing_feature_tls_text,
  },
  {
    id: "observe",
    icon: Analytics01Icon,
    title: m.landing_feature_observe_title,
    text: m.landing_feature_observe_text,
  },
  {
    id: "api",
    icon: ApiIcon,
    title: m.landing_feature_api_title,
    text: m.landing_feature_api_text,
  },
  {
    id: "rollback",
    icon: GitBranchIcon,
    title: m.landing_feature_rollback_title,
    text: m.landing_feature_rollback_text,
  },
  {
    id: "regions",
    icon: GlobalIcon,
    title: m.landing_feature_regions_title,
    text: m.landing_feature_regions_text,
  },
] as const;

export const steps = [
  { id: "connect", title: m.landing_step_connect, text: m.landing_step_connect_text },
  { id: "configure", title: m.landing_step_configure, text: m.landing_step_configure_text },
  { id: "observe", title: m.landing_step_observe, text: m.landing_step_observe_text },
] as const;

export type StepId = (typeof steps)[number]["id"];

/** Example API calls against this very console, one per onboarding step. */
export function apiExample(step: StepId): string {
  const api = `${window.location.origin}/api/v1`;
  switch (step) {
    case "connect":
      return [
        `curl -X POST ${api}/sites \\`,
        `  -H "x-api-key: $EDGEWEIR_KEY" \\`,
        `  -H "content-type: application/json" \\`,
        `  -d '{"name":"www","domains":["www.example.com"],`,
        `       "origins":[{"address":"203.0.113.10"}]}'`,
      ].join("\n");
    case "configure":
      return [
        `curl -X PATCH ${api}/sites/$SITE_ID \\`,
        `  -H "x-api-key: $EDGEWEIR_KEY" \\`,
        `  -H "content-type: application/json" \\`,
        `  -d '{"cacheRules":[{"extensions":["css","js","png"],`,
        `       "edgeTtlSeconds":86400}]}'`,
      ].join("\n");
    case "observe":
      return [`curl ${api}/overview \\`, `  -H "x-api-key: $EDGEWEIR_KEY"`].join("\n");
  }
}

/** Scrolls to a section without touching the URL (the router owns it). */
export function jumpTo(id: string) {
  return (event: React.MouseEvent) => {
    event.preventDefault();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(id)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth" });
  };
}

type Classes = { primary: string; secondary: string };

/**
 * Header actions: signed-out visitors get "log in" (and "sign up" when a
 * sign-up link is configured); signed-in visitors get the console instead.
 */
export function AuthActions({ page, signedIn, classes }: LandingProps & { classes: Classes }) {
  if (signedIn) {
    return (
      <Link to="/overview" className={classes.primary} data-testid="landing-console">
        {m.landing_console()}
      </Link>
    );
  }
  const { signupUrl } = page.settings;
  return (
    <>
      <Link
        to="/login"
        className={signupUrl ? classes.secondary : classes.primary}
        data-testid="landing-login"
      >
        {m.landing_login()}
      </Link>
      {signupUrl ? (
        <a href={signupUrl} className={classes.primary} data-testid="landing-signup">
          {m.landing_signup()}
        </a>
      ) : null}
    </>
  );
}

/** Hero call to action: the console when signed in, otherwise sign-up (or sign-in). */
export function PrimaryCta({
  page,
  signedIn,
  className,
  children,
}: LandingProps & { className: string; children?: React.ReactNode }) {
  if (signedIn) {
    return (
      <Link to="/overview" className={className}>
        {m.landing_console()}
        {children}
      </Link>
    );
  }
  const { signupUrl } = page.settings;
  return signupUrl ? (
    <a href={signupUrl} className={className}>
      {m.landing_get_started()}
      {children}
    </a>
  ) : (
    <Link to="/login" className={className}>
      {m.landing_get_started()}
      {children}
    </Link>
  );
}

export function LocaleSwitch({ className }: { className?: string }) {
  const next: Locale = getLocale() === "en" ? "zh-CN" : "en";
  return (
    <button
      type="button"
      className={className}
      aria-label={m.user_menu_language()}
      onClick={() => setLocale(next)}
      data-testid="landing-locale"
    >
      {localeLabels[next]()}
    </button>
  );
}

export function Icp({ icp, className }: { icp: string; className?: string }) {
  if (!icp) return null;
  return (
    <a
      href="https://beian.miit.gov.cn/"
      target="_blank"
      rel="noreferrer"
      className={className}
      data-testid="landing-icp"
    >
      {icp}
    </a>
  );
}

function prefersReducedMotion() {
  return (
    typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Plays the standard entrance once the element scrolls into view. */
export function Reveal({
  delay = 0,
  className,
  style,
  ...props
}: React.ComponentProps<"div"> & { delay?: number }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [visible, setVisible] = React.useState(
    () => prefersReducedMotion() || typeof IntersectionObserver === "undefined",
  );
  React.useEffect(() => {
    if (visible || !ref.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -10% 0px" },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [visible]);
  return (
    <div
      ref={ref}
      className={cn(visible ? "animate-enter" : "opacity-0", className)}
      style={{ ...style, animationDelay: `${delay}ms` }}
      {...props}
    />
  );
}

/** Deterministic 0..1 value for a string (region pins, mesh jitter). */
export function hashUnit(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10_000) / 10_000;
}
