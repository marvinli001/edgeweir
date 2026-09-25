import "@fontsource-variable/rubik";
import { ArrowRightDoubleIcon, Mail01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { Logo } from "@/components/logo";
import { formatNumber, m } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  Comet,
  EdgeNodeArt,
  HeroArt,
  RingedPlanet,
  RocketArt,
  SatelliteArt,
  SpotIcon,
  SupportArt,
  WorldGlobe,
} from "./orbit-art";
import {
  AuthActions,
  description,
  features,
  headline,
  Icp,
  jumpTo,
  type LandingProps,
  LocaleSwitch,
  PrimaryCta,
  Reveal,
  type StepId,
  steps,
  useLandingHead,
} from "./shared";

const cta =
  "group inline-flex items-center justify-center rounded-[6px] bg-[linear-gradient(85deg,var(--ob-rose-345)_-70%,var(--ob-amber-359)_106%)] font-medium text-white shadow-(--ob-shadow-cta) transition-[filter,translate] duration-200 hover:brightness-[1.06] active:translate-y-px focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ob-amber-371)";
const ctaLarge = cn(cta, "h-[62px] gap-6 px-8 text-lg sm:h-[70px] sm:text-xl");
const ctaMedium = cn(cta, "h-[54px] gap-5 px-7 text-lg");
const outlineLight =
  "group inline-flex h-[54px] items-center justify-center gap-5 rounded-[6px] border border-white px-7 text-lg font-medium text-white transition-colors hover:bg-white hover:text-(--ob-text) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

function Chevrons() {
  return (
    <HugeiconsIcon
      icon={ArrowRightDoubleIcon}
      strokeWidth={2.2}
      className="size-6 transition-transform duration-200 group-hover:translate-x-1 motion-reduce:transition-none"
    />
  );
}

const chips = [
  m.landing_chip_wildcard,
  m.landing_chip_rollback,
  m.landing_chip_stats,
  m.landing_chip_api,
  m.landing_chip_2fa,
  m.landing_chip_audit,
  m.landing_chip_roles,
  m.landing_chip_mtls,
];

const stepTitles: Record<StepId, () => string> = {
  connect: m.landing_orbit_step_connect_title,
  configure: m.landing_orbit_step_configure_title,
  observe: m.landing_orbit_step_observe_title,
};

function useScrolled(threshold = 24) {
  const [scrolled, setScrolled] = React.useState(false);
  React.useEffect(() => {
    const update = () => setScrolled(window.scrollY > threshold);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, [threshold]);
  return scrolled;
}

/** Navy space hero, sky-blue body, white cards and orange accents. */
export function OrbitLanding(props: LandingProps) {
  const { page } = props;
  const { brandName, contactEmail, icp } = page.settings;
  const stats = page.stats;
  const scrolled = useScrolled();
  useLandingHead(page);
  const nav = [
    { id: "features", label: m.landing_nav_products() },
    { id: "network", label: m.landing_nav_network() },
    { id: "steps", label: m.landing_step_connect() },
  ];
  const marquee =
    stats && stats.regions.length >= 3 ? stats.regions.map((r) => r.name) : chips.map((c) => c());

  return (
    <div
      className="landing-orbit min-h-svh overflow-x-clip bg-(--ob-sky) text-(--ob-text) antialiased"
      data-testid="landing-orbit"
    >
      <div className="sticky top-0 z-50 px-3 pt-3 sm:px-6 sm:pt-5">
        <header
          className={cn(
            "mx-auto flex h-[64px] max-w-[1140px] items-center gap-3 rounded-[14px] border border-white/10 px-3 text-white sm:h-[72px] sm:gap-8 transition-[background-color,box-shadow] duration-300 sm:px-5",
            scrolled
              ? "bg-(--ob-indigo-839)/90 shadow-(--ob-shadow-header) backdrop-blur-md"
              : "bg-white/[0.03]",
          )}
        >
          <Link to="/" className="flex shrink-0 items-center gap-2.5">
            <Logo className="size-8 text-(--ob-orange)" />
            <span
              className="truncate text-lg font-bold tracking-tight sm:text-[22px]"
              data-testid="landing-brand"
            >
              {brandName}
            </span>
          </Link>
          <nav className="ml-auto hidden items-center gap-8 text-[17px] text-white/90 lg:flex">
            {nav.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                onClick={jumpTo(item.id)}
                className="transition-colors hover:text-white"
              >
                {item.label}
              </a>
            ))}
            <a href="/api/v1/openapi.json" className="transition-colors hover:text-white">
              {m.landing_footer_api_docs()}
            </a>
          </nav>
          <div
            className="ml-auto flex items-center gap-2.5 sm:gap-3 lg:ml-0"
            data-testid="landing-auth"
          >
            <LocaleSwitch className="hidden px-1 text-[15px] text-white/75 transition-colors hover:text-white sm:block" />
            <AuthActions
              {...props}
              classes={{
                primary: cn(
                  cta,
                  "h-10 px-3.5 text-[15px] whitespace-nowrap sm:h-[46px] sm:px-5 sm:text-[17px]",
                ),
                secondary:
                  "inline-flex h-10 items-center rounded-[6px] border border-white px-3.5 text-[15px] whitespace-nowrap text-white transition-colors hover:bg-white hover:text-(--ob-text) sm:h-[46px] sm:px-5 sm:text-[17px]",
              }}
            />
          </div>
        </header>
      </div>

      <section className="relative mx-1.5 -mt-[70px] overflow-hidden rounded-[28px] bg-[radial-gradient(120%_90%_at_78%_8%,var(--ob-violet-649)_0%,var(--ob-violet-749)_36%,var(--ob-indigo-818)_68%,var(--ob-indigo-869)_100%)] text-white sm:mx-2 sm:-mt-[84px]">
        <RingedPlanet className="pointer-events-none absolute top-16 -left-44 hidden w-[440px] opacity-50 md:block" />
        <Comet
          className="landing-comet pointer-events-none absolute bottom-40 left-6 hidden w-36 md:block"
          style={{ "--angle": "-24deg" } as React.CSSProperties}
        />
        <Comet
          className="landing-comet pointer-events-none absolute top-60 -right-6 hidden w-40 lg:block"
          style={{ "--angle": "-30deg", animationDelay: "-2s" } as React.CSSProperties}
        />
        <Comet
          className="landing-comet pointer-events-none absolute right-8 bottom-24 hidden w-32 lg:block"
          style={{ "--angle": "-18deg", animationDelay: "-4s" } as React.CSSProperties}
        />
        <div className="relative mx-auto grid max-w-[1140px] items-center gap-4 px-6 pt-32 pb-8 sm:pt-36 lg:grid-cols-[1fr_1.05fr]">
          <div className="animate-enter">
            <h1
              className="text-[40px] leading-[1.15] font-bold tracking-[-0.01em] text-balance sm:text-[54px] sm:leading-[1.2]"
              data-testid="landing-headline"
            >
              {headline(page)}
            </h1>
            <p className="mt-7 max-w-[540px] text-lg leading-[1.6] text-white/90 sm:text-[20px]">
              {description(page)}
            </p>
            <div className="mt-11">
              <PrimaryCta {...props} className={ctaLarge}>
                <Chevrons />
              </PrimaryCta>
            </div>
            <p className="mt-6 text-sm font-medium text-white/85">{m.landing_orbit_ahead_text()}</p>
          </div>
          <div className="animate-enter lg:-mr-12" style={{ animationDelay: "150ms" }}>
            <HeroArt />
          </div>
        </div>
        {stats ? (
          <div className="relative z-10 flex flex-col items-center gap-4 px-6 pb-12 text-center">
            <div className="flex flex-wrap items-center justify-center gap-3">
              <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-1.5 text-sm ring-1 ring-white/15">
                <span className="size-2 rounded-full bg-emerald-400 shadow-(--ob-shadow-live)" />
                {m.landing_live_nodes({ count: formatNumber(stats.onlineNodes) })}
              </span>
              <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-1.5 text-sm ring-1 ring-white/15">
                <span className="font-bold text-(--ob-orange)">
                  {formatNumber(stats.regions.length)}
                </span>
                {m.landing_stat_regions()}
              </span>
            </div>
            <p className="text-lg text-white/90">
              {m.landing_orbit_trust({ count: formatNumber(stats.sites), brand: brandName })}
            </p>
          </div>
        ) : (
          <div className="h-10" />
        )}
      </section>

      <div
        className="overflow-hidden py-9 [mask-image:linear-gradient(90deg,transparent,black_12%,black_88%,transparent)]"
        aria-hidden="true"
      >
        <div className="landing-marquee flex w-max">
          {[0, 1].map((copy) => (
            <div key={copy} className="flex shrink-0 gap-16 pr-16">
              {marquee.map((word) => (
                <span
                  key={`${copy}-${word}`}
                  className="text-[30px] font-bold whitespace-nowrap text-(--ob-text)/25"
                >
                  {word}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      <section id="features" className="scroll-mt-28 px-6 pt-14 pb-6">
        <Reveal className="mx-auto max-w-4xl text-center">
          <h2 className="text-[28px] leading-tight font-bold sm:text-[45px] sm:leading-[1.2]">
            {m.landing_orbit_products_title()}
          </h2>
          <p className="mt-6 text-lg sm:text-2xl">{m.landing_orbit_products_text()}</p>
        </Reveal>
        <div className="relative mx-auto mt-16 grid max-w-[1250px] gap-5 lg:grid-cols-[1fr_300px_1fr] lg:gap-6">
          {[features.slice(0, 4), features.slice(4, 8)].map((column, side) => (
            <div
              key={column[0]?.id}
              className={cn("flex flex-col gap-5 lg:gap-9", side === 1 && "lg:order-3")}
            >
              {column.map((feature, i) => (
                <Reveal
                  key={feature.id}
                  delay={i * 80}
                  className={cn(
                    "group flex items-start gap-4 rounded-lg bg-white px-5 py-6 sm:gap-6 sm:px-7 shadow-(--ob-shadow-card) transition-[translate,box-shadow] duration-300 hover:-translate-y-0.5 hover:shadow-(--ob-shadow-card-hover) motion-reduce:transition-none motion-reduce:hover:translate-y-0",
                    (i === 0 || i === 3) && (side === 0 ? "lg:ml-[70px]" : "lg:mr-[70px]"),
                  )}
                >
                  <SpotIcon id={feature.id} className="size-16 shrink-0" />
                  <div>
                    <h3 className="text-xl font-bold transition-colors group-hover:text-(--ob-orange)">
                      {feature.title()}
                    </h3>
                    <p className="mt-1.5 text-[17px] leading-[1.6]">{feature.text()}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          ))}
          <div className="hidden items-center lg:order-2 lg:flex">
            <EdgeNodeArt className="-mx-[12%] w-[124%] max-w-none" />
          </div>
        </div>
        {stats ? (
          <dl
            className="mx-auto mt-20 grid max-w-5xl grid-cols-2 gap-y-8 lg:grid-cols-4"
            data-testid="landing-stats"
          >
            {[
              { label: m.landing_stat_regions(), value: stats.regions.length },
              { label: m.landing_stat_nodes(), value: stats.onlineNodes },
              { label: m.landing_stat_sites(), value: stats.sites },
              { label: m.landing_stat_domains(), value: stats.domains },
            ].map((item, i) => (
              <Reveal
                key={item.label}
                delay={i * 70}
                className="flex flex-col-reverse px-4 text-center lg:border-l lg:border-(--ob-text)/12 lg:first:border-l-0"
              >
                <dt className="mt-1 text-xl sm:text-2xl">{item.label}</dt>
                <dd className="text-[32px] font-bold tabular-nums">{formatNumber(item.value)}</dd>
              </Reveal>
            ))}
          </dl>
        ) : null}
      </section>

      <section className="px-6 pt-24 pb-10">
        <Reveal className="relative mx-auto max-w-[1110px] rounded-[10px] bg-(--ob-deep) px-8 py-12 text-white sm:px-[70px] sm:py-14">
          <div className="relative z-10 max-w-md">
            <h2 className="text-3xl leading-[1.25] font-bold sm:text-[40px]">
              {m.landing_orbit_ahead_title()}
            </h2>
            <div className="mt-9">
              <PrimaryCta {...props} className={ctaLarge}>
                <Chevrons />
              </PrimaryCta>
            </div>
            <p className="mt-8 text-sm font-medium text-(--ob-blue-296)">
              {m.landing_orbit_ahead_text()}
            </p>
          </div>
          <RocketArt
            smoke={false}
            className="pointer-events-none absolute -top-36 right-16 hidden w-[380px] lg:block"
          />
        </Reveal>
      </section>

      <Steps />

      <section id="network" className="scroll-mt-28 overflow-hidden px-6 pt-24">
        <Reveal className="mx-auto max-w-[920px] text-center">
          <h2 className="text-[28px] leading-tight font-bold sm:text-[45px] sm:leading-[1.2]">
            {m.landing_orbit_network_title()}
          </h2>
          <p className="mt-7 text-lg leading-[1.75] sm:text-[22px]">
            {m.landing_orbit_network_text()}
          </p>
        </Reveal>
        {stats ? (
          <div className="mx-auto mt-14 flex max-w-4xl flex-wrap justify-center gap-x-20 gap-y-8">
            {[
              { label: m.landing_stat_regions(), value: stats.regions.length },
              { label: m.landing_stat_nodes(), value: stats.onlineNodes },
              { label: m.landing_stat_sites(), value: stats.sites },
            ].map((item, i) => (
              <Reveal key={item.label} delay={i * 90} className="text-center">
                <p className="text-[64px] leading-none font-bold tracking-tight text-(--ob-orange) tabular-nums sm:text-[80px]">
                  {formatNumber(item.value)}
                </p>
                <p className="mt-2 text-xl sm:text-2xl">{item.label}</p>
              </Reveal>
            ))}
          </div>
        ) : null}
        <Reveal className="relative mx-auto mt-10 max-w-[1120px]" delay={120}>
          <WorldGlobe regions={stats?.regions ?? []} className="h-auto w-full" />
        </Reveal>
      </section>

      <section className="px-6 pt-10 pb-24">
        <Reveal className="relative mx-auto flex max-w-[1180px] flex-col gap-6 rounded-[10px] bg-(--ob-card) px-8 py-10 text-white sm:flex-row sm:items-center sm:py-12 sm:pr-8 sm:pl-[200px]">
          <SatelliteArt className="pointer-events-none absolute -top-16 left-0 hidden w-[200px] sm:block" />
          <div>
            <p className="text-2xl font-bold">{m.landing_orbit_unlock_title()}</p>
            <p className="mt-2 text-[15px] text-white/85">{m.landing_orbit_ahead_text()}</p>
          </div>
          <PrimaryCta {...props} className={cn(ctaMedium, "sm:ml-auto")}>
            <Chevrons />
          </PrimaryCta>
        </Reveal>
      </section>

      {contactEmail ? (
        <section className="px-6 pb-24">
          <Reveal className="relative mx-auto grid max-w-[1150px] items-center gap-10 overflow-hidden rounded-[40px] bg-(--ob-card) px-8 py-14 text-white sm:px-20 sm:py-16 lg:grid-cols-2">
            <div className="relative z-10">
              <h2 className="text-3xl leading-[1.2] font-bold sm:text-5xl">
                {m.landing_orbit_support_title()}
              </h2>
              <p className="mt-6 text-lg leading-snug text-white/90 sm:text-xl">
                {m.landing_orbit_support_text()}
              </p>
              <a href={`mailto:${contactEmail}`} className={cn(ctaMedium, "mt-10")}>
                <HugeiconsIcon icon={Mail01Icon} strokeWidth={2} className="size-5" />
                {contactEmail}
              </a>
              {stats ? (
                <div className="mt-12 flex flex-wrap gap-x-10 gap-y-5">
                  {[
                    { label: m.landing_stat_regions(), value: stats.regions.length },
                    { label: m.landing_stat_nodes(), value: stats.onlineNodes },
                    { label: m.landing_stat_domains(), value: stats.domains },
                  ].map((item) => (
                    <div key={item.label}>
                      <p className="text-4xl font-bold tabular-nums">{formatNumber(item.value)}</p>
                      <p className="mt-1 text-sm tracking-wide text-white/80 uppercase">
                        {item.label}
                      </p>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            <SupportArt className="w-full max-w-[460px] justify-self-center" />
          </Reveal>
        </section>
      ) : null}

      <section className="px-6 pb-20">
        <Reveal className="relative mx-auto max-w-[1140px] rounded-[16px] bg-(--ob-final) px-8 py-12 text-white sm:px-[60px] sm:py-14">
          <RingedPlanet
            tone="sunset"
            className="pointer-events-none absolute -top-24 -right-16 hidden w-[400px] lg:block"
          />
          <div className="relative max-w-[700px]">
            <h2 className="text-3xl leading-tight font-normal sm:text-[54px]">
              {m.landing_orbit_final_title()}
            </h2>
            <p className="mt-6 text-lg leading-snug font-light text-pretty text-white/90 sm:text-[26px]">
              {m.landing_orbit_final_text()}
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <PrimaryCta {...props} className={ctaMedium}>
                <Chevrons />
              </PrimaryCta>
              {contactEmail ? (
                <a href={`mailto:${contactEmail}`} className={outlineLight}>
                  {m.landing_contact()}
                  <Chevrons />
                </a>
              ) : null}
            </div>
            <p className="mt-4 text-[13px] text-white/70">{m.landing_orbit_ahead_text()}</p>
          </div>
        </Reveal>
      </section>

      <footer className="relative overflow-hidden bg-[linear-gradient(180deg,var(--ob-sky)_0%,var(--ob-blue-20)_100%)]">
        <div className="relative mx-auto grid max-w-[1110px] gap-10 px-6 pt-6 pb-14 sm:grid-cols-2 lg:grid-cols-4">
          <div className="flex items-center gap-2.5 self-start">
            <Logo className="size-9 text-(--ob-orange)" />
            <span className="text-[26px] font-bold tracking-tight">{brandName}</span>
          </div>
          <FooterColumn title={m.landing_nav_products()}>
            {nav.map((item) => (
              <a key={item.id} href={`#${item.id}`} onClick={jumpTo(item.id)}>
                {item.label}
              </a>
            ))}
          </FooterColumn>
          <FooterColumn title={m.landing_footer_developers()}>
            <a href="/api/v1/openapi.json">{m.landing_footer_api_docs()}</a>
            <Link to="/overview">{m.landing_console()}</Link>
          </FooterColumn>
          <FooterColumn title={m.landing_contact()}>
            {contactEmail ? (
              <a href={`mailto:${contactEmail}`} className="inline-flex items-center gap-2">
                <HugeiconsIcon icon={Mail01Icon} strokeWidth={2} className="size-4" />
                {contactEmail}
              </a>
            ) : null}
            <LocaleSwitch className="text-left" />
          </FooterColumn>
        </div>
        <div className="relative mx-auto grid max-w-[1110px] gap-10 px-6 pb-20 lg:grid-cols-[380px_1fr]">
          {contactEmail ? (
            <div>
              <p className="text-2xl font-bold">{m.landing_orbit_sales_title()}</p>
              <p className="mt-5 text-lg leading-relaxed">{m.landing_orbit_sales_text()}</p>
              <a href={`mailto:${contactEmail}`} className={cn(ctaMedium, "mt-8")}>
                {m.landing_contact()}
                <Chevrons />
              </a>
            </div>
          ) : (
            <div />
          )}
          <p className="self-end text-2xl font-bold sm:text-[30px]">{m.landing_orbit_tagline()}</p>
          <SatelliteArt className="pointer-events-none absolute -top-10 right-0 hidden w-[240px] opacity-90 xl:block" />
        </div>
        <div className="bg-(--ob-card) text-white">
          <div className="mx-auto flex max-w-[1110px] flex-wrap items-center gap-x-8 gap-y-3 px-6 py-8 text-[15px]">
            <span className="text-lg font-bold">
              {m.landing_footer_rights({
                year: String(new Date().getFullYear()),
                brand: brandName,
              })}
            </span>
            <Icp icp={icp} className="text-white/85 hover:text-white" />
            <a
              href="https://github.com/edgeweir/edgeweir"
              target="_blank"
              rel="noreferrer"
              className="text-white/85 hover:text-white sm:ml-auto"
            >
              {m.landing_powered_by()}
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FooterColumn({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-2xl font-bold">{title}</p>
      <div className="mt-6 flex flex-col items-start gap-2 text-lg [&>*]:transition-colors [&>*:hover]:text-(--ob-orange)">
        {children}
      </div>
    </div>
  );
}

function usePrefersReducedMotion() {
  const [reduce, setReduce] = React.useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  React.useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduce(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduce;
}

/** Accordion of onboarding steps beside a floating illustration; advances until touched. */
function Steps() {
  const [active, setActive] = React.useState<StepId>("connect");
  const [touched, setTouched] = React.useState(false);
  const reduce = usePrefersReducedMotion();
  React.useEffect(() => {
    if (touched || reduce) return;
    const timer = window.setInterval(() => {
      setActive((current) => {
        const i = steps.findIndex((s) => s.id === current);
        return (steps[(i + 1) % steps.length] ?? steps[0]).id;
      });
    }, 6000);
    return () => window.clearInterval(timer);
  }, [touched, reduce]);

  return (
    <section id="steps" className="scroll-mt-28 px-6 py-24">
      <Reveal className="mx-auto max-w-4xl text-center">
        <h2 className="text-[28px] leading-tight font-bold sm:text-[45px] sm:leading-[1.2]">
          {m.landing_orbit_steps_title()}
        </h2>
        <p className="mt-7 text-lg leading-[1.6] sm:text-2xl">{m.landing_orbit_steps_text()}</p>
      </Reveal>
      <div className="mx-auto mt-16 grid max-w-[1110px] items-center gap-12 lg:grid-cols-[470px_1fr]">
        <Reveal className="flex flex-col gap-1">
          {steps.map((step) => {
            const on = step.id === active;
            return (
              <button
                key={step.id}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  setTouched(true);
                  setActive(step.id);
                }}
                className={cn(
                  "border-l-[3px] px-5 py-5 text-left transition-[background-color,border-color] duration-300",
                  on
                    ? "border-(--ob-orange) bg-(image:--ob-step-active)"
                    : "border-transparent hover:bg-white/40",
                )}
              >
                <span className="block text-[26px] leading-tight font-medium sm:text-[30px]">
                  {stepTitles[step.id]()}
                </span>
                <span
                  className={cn(
                    "mt-2 block text-[15px] leading-[1.7]",
                    !on && "line-clamp-2 opacity-85",
                  )}
                >
                  {step.text()}
                </span>
              </button>
            );
          })}
        </Reveal>
        <Reveal delay={120}>
          <StepVisual step={active} />
        </Reveal>
      </div>
      <Reveal className="mx-auto mt-20 grid max-w-[1110px] gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
        {chips.map((chip) => (
          <span key={chip()} className="flex items-center gap-2 text-lg font-bold">
            <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-(--ob-orange) text-white">
              <HugeiconsIcon icon={Tick02Icon} strokeWidth={3.5} className="size-3" />
            </span>
            {chip()}
          </span>
        ))}
      </Reveal>
    </section>
  );
}

const card =
  "absolute rounded-2xl bg-white p-5 shadow-(--ob-shadow-float) ring-1 ring-(--ob-text)/6";

/** Floating UI cards in perspective, one composition per step. */
function StepVisual({ step }: { step: StepId }) {
  return (
    <div className="relative h-[400px] [perspective:1400px]" aria-hidden="true">
      <div
        key={step}
        className="absolute inset-0 animate-in fade-in zoom-in-95 duration-500 [transform:rotateY(-14deg)_rotateX(7deg)] [transform-style:preserve-3d] motion-reduce:animate-none"
      >
        {step === "connect" ? (
          <>
            <div className={cn(card, "top-4 left-[18%] w-[62%] [transform:translateZ(-60px)]")}>
              <p className="text-sm text-(--ob-text)/70">{m.sites_col_origins()}</p>
              <p className="mt-2 font-mono text-base font-medium">203.0.113.10:80</p>
            </div>
            <div className={cn(card, "top-[34%] left-0 w-[70%] [transform:translateZ(40px)]")}>
              <p className="text-sm text-(--ob-text)/70">{m.sites_col_domains()}</p>
              {["www.example.com", "static.example.com"].map((domain) => (
                <div
                  key={domain}
                  className="mt-3 flex items-center gap-3 rounded-lg bg-(--ob-sky)/70 px-3 py-2.5"
                >
                  <span className="size-2 rounded-full bg-emerald-500" />
                  <span className="font-mono text-[15px]">{domain}</span>
                </div>
              ))}
            </div>
            <div className="landing-float-slow absolute right-2 bottom-4 [transform:translateZ(80px)]">
              <SpotIcon id="cache" className="size-36 drop-shadow-(--ob-shadow-drop)" />
            </div>
          </>
        ) : step === "configure" ? (
          <>
            <div className={cn(card, "top-6 left-[4%] w-[88%] [transform:translateZ(20px)]")}>
              <p className="text-sm font-bold">{m.sites_col_cache()}</p>
              {[
                m.sites_cache_ttl({ prefix: "/static/", ttl: "86400" }),
                m.sites_cache_ttl({ prefix: ".css .js .png", ttl: "604800" }),
                m.sites_cache_bypass({ prefix: "/api/" }),
              ].map((rule, i) => (
                <div
                  key={rule}
                  className="mt-3 flex items-center gap-3 rounded-lg border border-(--ob-text)/10 px-3 py-3"
                >
                  <span className="flex size-6 items-center justify-center rounded-md bg-(--ob-card) font-mono text-xs text-white">
                    {i + 1}
                  </span>
                  <span className="font-mono text-[14px]">{rule}</span>
                  <span
                    className={cn(
                      "ml-auto flex h-5 w-9 items-center rounded-full p-0.5",
                      i < 2 ? "justify-end bg-(--ob-orange)" : "bg-(--ob-text)/15",
                    )}
                  >
                    <span className="size-4 rounded-full bg-white shadow" />
                  </span>
                </div>
              ))}
            </div>
            <div className="landing-float absolute right-0 bottom-2 [transform:translateZ(90px)]">
              <SpotIcon id="rollback" className="size-28 drop-shadow-(--ob-shadow-drop)" />
            </div>
          </>
        ) : (
          <>
            <div className={cn(card, "top-4 left-[4%] w-[86%] [transform:translateZ(20px)]")}>
              <p className="text-sm font-bold">{m.landing_orbit_traffic_title()}</p>
              <svg viewBox="0 0 320 120" className="mt-4 h-auto w-full" aria-hidden="true">
                <defs>
                  <linearGradient id="orbit-area" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="var(--ob-orange)" stopOpacity="0.35" />
                    <stop offset="1" stopColor="var(--ob-orange)" stopOpacity="0" />
                  </linearGradient>
                </defs>
                <path
                  d="M0 90C30 80 44 50 74 56S120 96 150 70 196 20 226 34 280 70 320 30V120H0Z"
                  fill="url(#orbit-area)"
                />
                <path
                  d="M0 90C30 80 44 50 74 56S120 96 150 70 196 20 226 34 280 70 320 30"
                  fill="none"
                  stroke="var(--ob-orange)"
                  strokeWidth={3}
                  strokeLinecap="round"
                />
                <path
                  d="M0 104C40 98 70 84 100 88S160 104 200 84 270 72 320 64"
                  fill="none"
                  stroke="var(--ob-blue-437)"
                  strokeWidth={3}
                  strokeLinecap="round"
                />
              </svg>
              <div className="mt-3 flex gap-5 text-sm">
                <span className="flex items-center gap-2">
                  <span className="size-2.5 rounded-full bg-(--ob-orange)" />
                  {m.landing_orbit_traffic_requests()}
                </span>
                <span className="flex items-center gap-2">
                  <span className="size-2.5 rounded-full bg-(--ob-blue-437)" />
                  {m.landing_orbit_traffic_hits()}
                </span>
              </div>
            </div>
            <div
              className={cn(
                card,
                "right-0 bottom-2 flex items-center gap-4 [transform:translateZ(90px)]",
              )}
            >
              <svg viewBox="0 0 48 48" className="size-14" aria-hidden="true">
                <circle cx={24} cy={24} r={18} fill="none" stroke="var(--ob-sky)" strokeWidth={8} />
                <circle
                  cx={24}
                  cy={24}
                  r={18}
                  fill="none"
                  stroke="var(--ob-orange)"
                  strokeWidth={8}
                  strokeDasharray="96 113"
                  strokeLinecap="round"
                  transform="rotate(-90 24 24)"
                />
              </svg>
              <span className="text-sm font-bold">{m.landing_orbit_hit_ratio()}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
