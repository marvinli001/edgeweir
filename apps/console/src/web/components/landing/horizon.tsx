import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  CodeSquareIcon,
  Coins01Icon,
  FlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { Logo } from "@/components/logo";
import { formatNumber, m } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  AuthActions,
  apiExample,
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

const container = "mx-auto w-full max-w-7xl px-6 lg:px-10";
const blueButton =
  "inline-flex h-10 items-center justify-center gap-2 rounded-md bg-(--hz-blue) px-5 text-sm font-medium text-white transition-colors hover:bg-(--hz-blue-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--hz-blue)";
const outlineDark =
  "inline-flex h-10 items-center justify-center gap-2 rounded-md border border-(--hz-ink) px-5 text-sm font-medium text-(--hz-ink) transition-colors hover:bg-(--hz-ink) hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2";
const outlineLight =
  "inline-flex h-10 items-center justify-center gap-2 rounded-md border border-white/80 px-5 text-sm font-medium text-white transition-colors hover:bg-white hover:text-black focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

/** Black hero, warm paper sections and a violet-to-orange glow. */
export function HorizonLanding(props: LandingProps) {
  const { page } = props;
  const { brandName, contactEmail, icp } = page.settings;
  const stats = page.stats;
  useLandingHead(page);
  const nav = [
    { id: "features", label: m.landing_nav_products() },
    ...(stats ? [{ id: "network", label: m.landing_nav_network() }] : []),
    { id: "faq", label: m.landing_nav_faq() },
  ];

  return (
    <div
      className="landing-horizon min-h-svh bg-(--hz-paper) font-sans text-(--hz-ink) antialiased"
      data-testid="landing-horizon"
    >
      <header className="sticky top-0 z-40 border-b border-(--hz-line) bg-white/95 backdrop-blur">
        <div className="hidden border-b border-(--hz-line) bg-(--hz-paper) md:block">
          <div className={cn(container, "flex h-9 items-center justify-end gap-6 text-xs")}>
            <LocaleSwitch className="text-(--hz-muted) transition-colors hover:text-(--hz-ink)" />
            {contactEmail ? (
              <a
                href={`mailto:${contactEmail}`}
                className="text-(--hz-muted) transition-colors hover:text-(--hz-ink)"
              >
                {m.landing_contact()}
              </a>
            ) : null}
          </div>
        </div>
        <div className={cn(container, "flex h-16 items-center gap-8")}>
          <Link to="/" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Logo className="size-6 text-(--hz-ink)" />
            <span data-testid="landing-brand">{brandName}</span>
          </Link>
          <nav className="hidden items-center gap-7 text-sm font-medium md:flex">
            {nav.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                onClick={jumpTo(item.id)}
                className="transition-colors hover:text-(--hz-blue)"
              >
                {item.label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3" data-testid="landing-auth">
            <AuthActions
              {...props}
              classes={{
                primary: cn(blueButton, "h-9 px-4"),
                secondary: cn(outlineDark, "h-9 px-4"),
              }}
            />
          </div>
        </div>
      </header>

      <section className="relative overflow-hidden bg-(--hz-black) text-white">
        <div
          aria-hidden="true"
          className="landing-glow pointer-events-none absolute -right-[18%] -bottom-[62%] size-[min(110vw,1100px)] rounded-full bg-[radial-gradient(circle_at_center,var(--hz-orange)_0%,var(--hz-magenta)_30%,var(--hz-violet)_52%,transparent_70%)] opacity-60 blur-3xl"
        />
        <div
          className={cn(
            container,
            "relative grid items-center gap-14 py-20 lg:grid-cols-[1.05fr_1fr] lg:py-28",
          )}
        >
          <div className="animate-enter">
            <h1
              className="text-5xl leading-[1.04] font-light tracking-tight text-balance sm:text-6xl lg:text-7xl"
              data-testid="landing-headline"
            >
              {headline(page)}
            </h1>
            <p className="mt-10 text-sm font-semibold">
              {m.landing_hero_eyebrow({ brand: brandName })}
            </p>
            <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-white/75">
              {description(page)}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <PrimaryCta {...props} className={blueButton}>
                <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="size-4" />
              </PrimaryCta>
              {contactEmail ? (
                <a href={`mailto:${contactEmail}`} className={outlineLight}>
                  {m.landing_contact()}
                </a>
              ) : null}
            </div>
          </div>
          <div className="relative animate-enter" style={{ animationDelay: "150ms" }}>
            <div className="relative aspect-[4/3] border border-white/70">
              <NetworkMesh />
              {stats ? (
                <div className="absolute bottom-4 left-4 flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs backdrop-blur">
                  <span className="relative flex size-2">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:animate-none" />
                    <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
                  </span>
                  {m.landing_live_nodes({ count: formatNumber(stats.onlineNodes) })}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section className={cn(container, "py-24 lg:py-32")}>
        <Reveal>
          <h2 className="max-w-3xl text-4xl font-light tracking-tight text-balance lg:text-5xl">
            {m.landing_value_title()}
          </h2>
          <p className="mt-5 max-w-3xl leading-relaxed text-(--hz-muted)">
            {m.landing_value_text({ brand: brandName })}
          </p>
        </Reveal>
        <div className="mt-14 grid gap-5 md:grid-cols-3">
          {[
            {
              icon: FlashIcon,
              title: m.landing_value_speed_title,
              text: m.landing_value_speed_text,
            },
            {
              icon: Coins01Icon,
              title: m.landing_value_cost_title,
              text: m.landing_value_cost_text,
            },
            {
              icon: CodeSquareIcon,
              title: m.landing_value_dev_title,
              text: m.landing_value_dev_text,
            },
          ].map((card, i) => (
            <Reveal
              key={card.title()}
              delay={i * 90}
              className="group flex min-h-64 flex-col border md:min-h-80 border-(--hz-line) bg-white p-8 transition-[border-color,box-shadow,translate] duration-300 hover:-translate-y-1 hover:border-(--hz-ink) hover:shadow-(--hz-shadow-card) motion-reduce:transition-none motion-reduce:hover:translate-y-0"
            >
              <span className="flex size-11 items-center justify-center border border-(--hz-line) transition-colors group-hover:border-(--hz-ink)">
                <HugeiconsIcon icon={card.icon} strokeWidth={1.5} className="size-5" />
              </span>
              <h3 className="mt-auto pt-10 text-xl font-medium md:pt-16">{card.title()}</h3>
              <p className="mt-3 text-sm leading-relaxed text-(--hz-muted)">{card.text()}</p>
            </Reveal>
          ))}
        </div>
      </section>

      <section id="features" className="scroll-mt-28 border-t border-(--hz-line) bg-white">
        <div className={cn(container, "py-24 lg:py-32")}>
          <Reveal>
            <p className="text-xs font-semibold tracking-[0.2em] text-(--hz-muted) uppercase">
              {m.landing_features_eyebrow()}
            </p>
            <h2 className="mt-4 max-w-3xl text-4xl font-light tracking-tight text-balance lg:text-5xl">
              {m.landing_features_title()}
            </h2>
          </Reveal>
          <div className="mt-16 grid gap-x-10 gap-y-14 sm:grid-cols-2 lg:grid-cols-4">
            {features.map((feature, i) => (
              <Reveal key={feature.id} delay={(i % 4) * 80}>
                <span className="flex size-9 items-center justify-center rounded-md bg-(--hz-blue)/10 text-(--hz-blue)">
                  <HugeiconsIcon icon={feature.icon} strokeWidth={2} className="size-[18px]" />
                </span>
                <h3 className="mt-5 font-semibold">{feature.title()}</h3>
                <p className="mt-2 text-sm leading-relaxed text-(--hz-muted)">{feature.text()}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <Workflow />

      {stats ? (
        <section
          id="network"
          className="scroll-mt-28 bg-(--hz-black) text-white"
          data-testid="landing-stats"
        >
          <div className={cn(container, "py-24 lg:py-32")}>
            <Reveal>
              <p className="text-xs font-semibold tracking-[0.2em] text-white/50 uppercase">
                {m.landing_nav_network()}
              </p>
              <h2 className="mt-4 text-4xl font-light tracking-tight lg:text-5xl">
                {m.landing_network_title()}
              </h2>
            </Reveal>
            <dl className="mt-16 grid grid-cols-2 gap-px overflow-hidden border border-white/15 bg-white/15 lg:grid-cols-4">
              {[
                { label: m.landing_stat_regions(), value: stats.regions.length },
                { label: m.landing_stat_nodes(), value: stats.onlineNodes },
                { label: m.landing_stat_sites(), value: stats.sites },
                { label: m.landing_stat_domains(), value: stats.domains },
              ].map((item, i) => (
                <Reveal key={item.label} delay={i * 80} className="bg-(--hz-black) p-8">
                  <dt className="text-sm text-white/55">{item.label}</dt>
                  <dd className="mt-3 text-5xl font-light tabular-nums lg:text-6xl">
                    {formatNumber(item.value)}
                  </dd>
                </Reveal>
              ))}
            </dl>
            {stats.regions.length > 0 ? (
              <Reveal className="mt-10 flex flex-wrap gap-2">
                {stats.regions.map((region) => (
                  <span
                    key={region.code}
                    className="rounded-full border border-white/20 px-3 py-1 text-sm text-white/80"
                  >
                    {region.name}
                    <span className="ml-2 font-mono text-xs text-white/40">{region.code}</span>
                  </span>
                ))}
              </Reveal>
            ) : null}
          </div>
        </section>
      ) : null}

      <section id="faq" className={cn(container, "scroll-mt-28 py-24 lg:py-32")}>
        <div className="grid gap-12 lg:grid-cols-[1fr_2fr]">
          <Reveal>
            <h2 className="text-4xl font-light tracking-tight lg:text-5xl">
              {m.landing_faq_title()}
            </h2>
          </Reveal>
          <div className="flex flex-col gap-3">
            {[
              { q: m.landing_faq_what_q, a: m.landing_faq_what_a },
              { q: m.landing_faq_start_q, a: m.landing_faq_start_a },
              { q: m.landing_faq_purge_q, a: m.landing_faq_purge_a },
              { q: m.landing_faq_api_q, a: m.landing_faq_api_a },
            ].map(({ q, a }, i) => (
              <Reveal key={q()} delay={i * 60}>
                <details className="group border border-(--hz-line) bg-white open:border-(--hz-ink)">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-6 px-6 py-5 font-medium [&::-webkit-details-marker]:hidden">
                    {q()}
                    <HugeiconsIcon
                      icon={ArrowDown01Icon}
                      strokeWidth={2}
                      className="size-4 shrink-0 transition-transform duration-300 group-open:rotate-180 motion-reduce:transition-none"
                    />
                  </summary>
                  <p className="px-6 pb-6 text-sm leading-relaxed text-(--hz-muted)">{a()}</p>
                </details>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="relative overflow-hidden bg-(--hz-black) text-white">
        <div
          aria-hidden="true"
          className="landing-glow pointer-events-none absolute -top-1/2 -right-[10%] size-[min(90vw,900px)] rounded-full bg-[radial-gradient(circle_at_center,var(--hz-magenta)_0%,var(--hz-violet)_40%,transparent_70%)] opacity-50 blur-3xl"
        />
        <div className={cn(container, "relative py-24 lg:py-28")}>
          <Reveal>
            <h2 className="text-4xl font-light tracking-tight lg:text-6xl">
              {m.landing_cta_title()}
            </h2>
            <p className="mt-4 text-white/70">{m.landing_cta_text()}</p>
            <div className="mt-10 flex flex-wrap gap-3">
              <PrimaryCta {...props} className={blueButton} />
              {contactEmail ? (
                <a href={`mailto:${contactEmail}`} className={outlineLight}>
                  {m.landing_contact()}
                </a>
              ) : null}
            </div>
          </Reveal>
        </div>
      </section>

      <footer className="border-t border-white/10 bg-(--hz-black) text-sm text-white/60">
        <div className={cn(container, "grid gap-10 py-16 sm:grid-cols-2 lg:grid-cols-4")}>
          <div className="flex items-center gap-2 self-start text-lg font-semibold text-white">
            <Logo className="size-6 text-white" />
            {brandName}
          </div>
          <FooterColumn title={m.landing_nav_products()}>
            {nav.map((item) => (
              <a key={item.id} href={`#${item.id}`} onClick={jumpTo(item.id)}>
                {item.label}
              </a>
            ))}
          </FooterColumn>
          <FooterColumn title={m.landing_footer_resources()}>
            <Link to="/overview">{m.landing_console()}</Link>
            <a href="/api/v1/openapi.json">{m.landing_footer_api_docs()}</a>
          </FooterColumn>
          <FooterColumn title={m.landing_contact()}>
            {contactEmail ? <a href={`mailto:${contactEmail}`}>{contactEmail}</a> : null}
            <LocaleSwitch className="text-left" />
          </FooterColumn>
        </div>
        <div
          className={cn(
            container,
            "flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-white/10 py-6 text-xs",
          )}
        >
          <span>
            {m.landing_footer_rights({ year: String(new Date().getFullYear()), brand: brandName })}
          </span>
          <Icp icp={icp} className="hover:text-white" />
          <a
            href="https://github.com/marvinli001/edgeweir"
            target="_blank"
            rel="noreferrer"
            className="ml-auto hover:text-white"
          >
            {m.landing_powered_by()}
          </a>
        </div>
      </footer>
    </div>
  );
}

function FooterColumn({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold tracking-[0.15em] text-white uppercase">{title}</p>
      <div className="mt-4 flex flex-col items-start gap-2.5 [&>*]:transition-colors [&>*:hover]:text-white">
        {children}
      </div>
    </div>
  );
}

/** Tabbed walk through onboarding, with the matching call against this console's API. */
function Workflow() {
  const [active, setActive] = React.useState<StepId>("connect");
  const index = steps.findIndex((s) => s.id === active);
  const step = steps[index] ?? steps[0];
  return (
    <section className={cn(container, "py-24 lg:py-32")}>
      <Reveal>
        <h2 className="max-w-3xl text-4xl font-light tracking-tight text-balance lg:text-5xl">
          {m.landing_workflow_title()}
        </h2>
      </Reveal>
      <Reveal delay={80} className="mt-12">
        <div role="tablist" className="grid grid-cols-3 gap-1">
          {steps.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === active}
              onClick={() => setActive(s.id)}
              className={cn(
                "h-11 border text-sm font-medium transition-colors",
                s.id === active
                  ? "border-(--hz-ink) bg-(--hz-ink) text-white"
                  : "border-(--hz-line) bg-white hover:border-(--hz-ink)",
              )}
            >
              {s.title()}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          key={step.id}
          className="mt-4 grid gap-10 border border-(--hz-line) bg-white p-8 animate-in fade-in duration-500 motion-reduce:animate-none lg:grid-cols-2 lg:p-12"
        >
          <div>
            <p className="font-mono text-sm text-(--hz-muted)">0{index + 1}</p>
            <h3 className="mt-6 text-3xl font-light tracking-tight">{step.title()}</h3>
            <p className="mt-4 max-w-md leading-relaxed text-(--hz-muted)">{step.text()}</p>
          </div>
          <pre className="overflow-x-auto bg-(--hz-black) p-6 font-mono text-xs leading-relaxed text-white/85">
            <code>{apiExample(step.id)}</code>
          </pre>
        </div>
      </Reveal>
    </section>
  );
}

const MESH: [number, number][] = [
  [52, 70],
  [148, 38],
  [238, 104],
  [330, 52],
  [430, 92],
  [540, 48],
  [96, 184],
  [196, 228],
  [300, 172],
  [402, 214],
  [506, 164],
  [560, 262],
  [60, 318],
  [168, 356],
  [276, 300],
  [380, 346],
  [468, 306],
  [540, 392],
  [250, 410],
];

/** Each node linked to its nearest neighbours, without duplicates. */
const LINKS: [number, number][] = (() => {
  const seen = new Set<string>();
  const links: [number, number][] = [];
  MESH.forEach(([x, y], i) => {
    MESH.map(([u, v], j) => ({ j, d: (u - x) ** 2 + (v - y) ** 2 }))
      .filter((n) => n.j !== i)
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
      .forEach(({ j }) => {
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (!seen.has(key)) {
          seen.add(key);
          links.push([i, j]);
        }
      });
  });
  return links;
})();

function NetworkMesh() {
  const id = React.useId();
  const gradient = `${id}-flow`;
  const point = (i: number) => MESH[i] ?? [0, 0];
  return (
    <svg viewBox="0 0 600 450" className="absolute inset-0 size-full" aria-hidden="true">
      <defs>
        <linearGradient
          id={gradient}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2="600"
          y2="450"
        >
          <stop offset="0" style={{ stopColor: "var(--hz-violet)" }} />
          <stop offset="0.55" style={{ stopColor: "var(--hz-magenta)" }} />
          <stop offset="1" style={{ stopColor: "var(--hz-orange)" }} />
        </linearGradient>
      </defs>
      {Array.from({ length: 11 }, (_, i) => (
        <line
          // biome-ignore lint/suspicious/noArrayIndexKey: static grid
          key={`v${i}`}
          x1={i * 60}
          y1={0}
          x2={i * 60}
          y2={450}
          stroke="white"
          strokeOpacity={0.05}
        />
      ))}
      {LINKS.map(([a, b]) => {
        const [x1, y1] = point(a);
        const [x2, y2] = point(b);
        return (
          <line
            key={`l${a}-${b}`}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke="white"
            strokeOpacity={0.3}
          />
        );
      })}
      {LINKS.filter((_, i) => i % 3 === 0).map(([a, b], i) => {
        const [x1, y1] = point(a);
        const [x2, y2] = point(b);
        return (
          <line
            key={`f${a}-${b}`}
            className="hz-flow"
            style={{ animationDelay: `${-i * 0.37}s` }}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={`url(#${gradient})`}
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray="6 14"
          />
        );
      })}
      {MESH.map(([x, y], i) => (
        <g key={`n${x}-${y}`}>
          {i % 4 === 0 ? (
            <circle
              cx={x}
              cy={y}
              r={3.5}
              fill="none"
              stroke={`url(#${gradient})`}
              className="landing-ping"
              style={{ animationDelay: `${i * 0.21}s` }}
            />
          ) : null}
          <circle cx={x} cy={y} r={i % 4 === 0 ? 4 : 2.5} fill="white" />
        </g>
      ))}
    </svg>
  );
}
