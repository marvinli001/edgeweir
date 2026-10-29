import { existsSync, globSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");
const webSources = globSync("src/web/{routes,components,lib}/**/*.{ts,tsx}", { cwd: root });
/** Everything the browser gets from src/web, minus generated code. */
const allWeb = globSync("src/web/**/*.{ts,tsx,css}", {
  cwd: root,
  exclude: ["src/web/paraglide/**", "src/web/routeTree.gen.ts"],
});

describe("UI rules (ADR-0003)", () => {
  it("never uses skeleton placeholders or pulsing blocks (loading is TopProgress and LoadingState)", () => {
    expect(allWeb.length).toBeGreaterThan(20);
    for (const file of allWeb) {
      const source = read(file);
      expect(/\bSkeleton\b|skeleton-shimmer/.test(source), file).toBe(false);
      expect(/\banimate-pulse\b/.test(source), file).toBe(false);
    }
  });

  it("uses no description slots: one-line safety notes use SafetyNote, alerts keep their message", () => {
    // CardDescription, DialogDescription, SheetDescription, AlertDialogDescription,
    // FieldDescription, EmptyDescription… are the explanatory paragraphs decision 7 rules out.
    // An alert's AlertDescription is the alert message itself (ErrorState), so it stays.
    const found = webSources.flatMap((file) =>
      [...read(file).matchAll(/<([A-Z][A-Za-z]*Description)\b/g)]
        .map((m) => m[1] as string)
        .filter((name) => name !== "AlertDescription")
        .map((name) => `${file}: <${name}>`),
    );
    expect(found).toEqual([]);
  });

  it("spells out no colors in TS/TSX: they come from CSS tokens", () => {
    // Hex (#rgb, #rrggbb, #rrggbbaa) and functional notation with literal channels. Named keywords
    // (white, transparent, currentColor) and Tailwind palette classes are tokens already.
    const color =
      /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-zA-Z])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*[\d.]/;
    const found = allWeb
      .filter((file) => !file.endsWith(".css"))
      .flatMap((file) =>
        read(file)
          .split("\n")
          .flatMap((line, i) => (color.test(line) ? [`${file}:${i + 1} ${line.trim()}`] : [])),
      );
    expect(found).toEqual([]);
  });

  it("links nothing on other sites except a short allow list (no phone-home, self-hosted assets)", () => {
    const allowed = [
      // This project's operating guide and the bundled GeoIP data's required attribution.
      "https://github.com/marvinli001/edgeweir/blob/master/docs/guide/rules.md",
      "https://ipinfo.io",
      // XML namespace name, never fetched.
      "http://www.w3.org/2000/svg",
    ];
    // Reserved documentation names (RFC 2606, RFC 6761) in placeholders and examples.
    const reserved = /^(?:[a-z0-9-]+\.)*(?:example(?:\.(?:com|net|org))?|test|invalid|localhost)$/;
    const files = [
      ...allWeb,
      "index.html",
      ...globSync("public/**/*", { cwd: root }).filter((file) =>
        statSync(resolve(root, file)).isFile(),
      ),
    ];
    const found = files.flatMap((file) =>
      [...read(file).matchAll(/\b(?:https?|wss?):\/\/[^\s"'`)<>\\]*/g)]
        .map((m) => m[0])
        .filter((url) => {
          if (allowed.includes(url)) return false;
          const host = /^[a-z]+:\/\/([^/:?#]+)/.exec(url)?.[1];
          return host === undefined ? false : !reserved.test(host);
        })
        .map((url) => `${file}: ${url}`),
    );
    expect(found).toEqual([]);
  });

  it("builds on Arc's free components only: no shadcn/ui or appica parts, files or packages", () => {
    // ADR-0064: Arc (free, MIT) for the primitives, components/layout for the console's own panels,
    // forms and tables on the tokens. The shadcn/ui copies, appica-ui and their libraries are gone
    // and stay gone.
    for (const dir of ["src/web/components/ui", "src/web/components/appica"]) {
      expect(existsSync(resolve(root, dir)), dir).toBe(false);
    }
    expect(existsSync(resolve(root, "src/web/appica-bridge.css"))).toBe(false);
    const banned =
      /^(?:@appica\/.+|shadcn|recharts|cmdk|class-variance-authority|vaul|sonner|input-otp|react-day-picker|embla-carousel-react|@radix-ui\/.+|radix-ui|lucide-react)$/;
    const pkg = JSON.parse(read("package.json"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((name) => banned.test(name))).toEqual([]);
    const sources = [...allWeb, ...globSync("lab/**/*.{ts,tsx}", { cwd: root })];
    const imported = sources.flatMap((file) =>
      [...read(file).matchAll(/(?:from\s+|import\s+|import\(|@import\s+)\s*"([^"]+)"/g)]
        .map((m) => m[1] as string)
        .filter(
          (spec) =>
            /^@\/components\/(?:ui|appica)\//.test(spec) ||
            /appica-bridge/.test(spec) ||
            banned.test(
              (spec.startsWith("@")
                ? spec.split("/").slice(0, 2)
                : spec.split("/").slice(0, 1)
              ).join("/"),
            ),
        )
        .map((spec) => `${file}: ${spec}`),
    );
    expect(imported).toEqual([]);
  });

  it("keeps the console's own layout parts on Base UI, Arc and the tokens", () => {
    // components/layout (Panel, Field, Table, InputGroup…) is the console's code: Base UI for any
    // behaviour, Arc for controls, tokens for looks; no other UI library comes in through it.
    const layout = webSources.filter((file) => file.includes("components/layout/"));
    expect(layout.length).toBeGreaterThan(4);
    const imports = layout.flatMap((file) =>
      [...read(file).matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gms)]
        .map((m) => m[1] as string)
        .filter(
          (spec) =>
            !/^(?:react|@base-ui\/react\/[a-z-]+|@hugeicons\/(?:react|core-free-icons)|@\/components\/arc\/[a-z-]+\/[a-z-]+|@\/lib\/(?:i18n|row-link|utils)|\.{1,2}\/.+)$/.test(
              spec,
            ),
        )
        .map((spec) => `${file}: ${spec}`),
    );
    expect(imports).toEqual([]);
  });

  it("imports visual effect libraries only through src/web/components/effects", () => {
    // Canvas, WebGL, map, graph and animation libraries come in through components/effects, where
    // their colors are read from tokens and their loops follow reduced motion and visibility
    // (ADR-0064). Side-effect imports (`import "uplot/dist/uPlot.min.css"`) count too.
    const effectLibraries =
      /(?:from\s+|import\s+|import\()\s*"(?:cobe|uplot|@xyflow\/[a-z-]+|@dagrejs\/[a-z-]+|@paper-design\/[a-z-]+|@number-flow\/[a-z-]+|motion|framer-motion|maplibre-gl|@vis\.gl\/[a-z-]+|d3-geo|topojson-client|world-atlas|dotted-map|react-activity-calendar)["/]/;
    const files = [...webSources, ...globSync("src/web/*.{ts,tsx}", { cwd: root })];
    const outside = files.filter(
      (file) => !file.includes("components/effects/") && effectLibraries.test(read(file)),
    );
    expect(outside).toEqual([]);
  });

  it("animates with Motion's light components under LazyMotion (no drag or layout code in the entry)", () => {
    // `motion.*` from "motion/react" bundles drag, pan and layout projection, and Rolldown puts
    // Motion in a chunk the entry preloads; `motion/react-m` + LazyMotion(domAnimation) does not.
    const full = /import\s*\{[^}]*\b(?:motion|m)\b[^}]*\}\s*from\s*"motion\/react"/;
    const found = webSources.filter((file) => full.test(read(file)));
    expect(found).toEqual([]);
    const settings = read("src/web/components/effects/motion-config.tsx");
    expect(settings).toMatch(/<LazyMotion features=\{domAnimation\} strict>/);
  });

  it("uses none of the excluded visual libraries (license, runtime downloads or weight)", () => {
    // GSAP (non-OSI license), React Bits and Animate UI (Commons Clause), three.js renderers,
    // Spline, Rive and dotLottie (runtime fetches from other hosts, WASM). ADR-0064.
    const banned =
      /^(?:gsap|@gsap\/.+|react-bits|@react-bits\/.+|animate-ui|@animate-ui\/.+|@react-three\/.+|@splinetool\/.+|@rive-app\/.+|@lottiefiles\/dotlottie-.+)$/;
    const manifests = globSync("{package.json,apps/*/package.json,packages/*/package.json}", {
      cwd: resolve(root, "../.."),
    });
    const declared = manifests.flatMap((file) => {
      const pkg = JSON.parse(readFileSync(resolve(root, "../..", file), "utf8"));
      return Object.keys({
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.optionalDependencies,
        ...pkg.peerDependencies,
      })
        .filter((name) => banned.test(name))
        .map((name) => `${file}: ${name}`);
    });
    expect(declared).toEqual([]);
    const sources = [...allWeb, ...globSync("lab/**/*.{ts,tsx}", { cwd: root })];
    const imported = sources.flatMap((file) =>
      [...read(file).matchAll(/(?:from\s+|import\s+|import\()\s*"([^"./][^"]*)"/g)]
        .map((m) => m[1] as string)
        .map((spec) =>
          (spec.startsWith("@") ? spec.split("/").slice(0, 2) : spec.split("/").slice(0, 1)).join(
            "/",
          ),
        )
        .filter((name) => banned.test(name))
        .map((name) => `${file}: ${name}`),
    );
    expect(imported).toEqual([]);
  });

  it("loads the WebGL, canvas, map and graph effects lazily (code split per page)", () => {
    // An effect module is heavy when it imports one of these libraries, or statically imports a
    // heavy effect module. Outside components/effects, heavy modules come in through React.lazy.
    const heavyLibrary =
      /^import\s+(?!type\b)[^;]*from\s+"(?:cobe|uplot|@xyflow\/[a-z-]+|@dagrejs\/[a-z-]+|@paper-design\/[a-z-]+|maplibre-gl|@vis\.gl\/[a-z-]+|d3-geo)["/]/m;
    const effects = webSources.filter((file) => file.includes("components/effects/"));
    const name = (file: string) =>
      file.replace(/^.*components\/effects\//, "").replace(/\.tsx?$/, "");
    const staticEffectImports = (source: string) =>
      [
        ...source.matchAll(
          /^import\s+(?!type\b)[^;]*from\s+"(?:@\/components\/effects\/|\.\/)([a-z-]+)";/gm,
        ),
      ].map((m) => m[1] as string);
    const heavy = new Set(effects.filter((file) => heavyLibrary.test(read(file))).map(name));
    for (let grew = true; grew; ) {
      grew = false;
      for (const file of effects) {
        if (!heavy.has(name(file)) && staticEffectImports(read(file)).some((n) => heavy.has(n))) {
          heavy.add(name(file));
          grew = true;
        }
      }
    }
    expect([...heavy]).toEqual(expect.arrayContaining(["live-chart", "origin-topology"]));
    const imports = webSources
      .filter((file) => !file.includes("components/effects/"))
      .flatMap((file) =>
        [
          ...read(file).matchAll(
            /^import\s+(?!type\b)[^;]*from\s+"@\/components\/effects\/([a-z-]+)";/gm,
          ),
        ]
          .map((m) => m[1] as string)
          .filter((n) => heavy.has(n))
          .map((n) => `${file}: ${n}`),
      );
    expect(imports).toEqual([]);
  });

  it("loads the design tokens once, before the Arc bridge that reads them", () => {
    // tokens.css holds every --ew- value (tokens.md); foundation.css maps Arc's names onto them.
    const index = read("src/web/index.css");
    const tokens = index.indexOf('@import "./tokens.css"');
    const bridge = index.indexOf('@import "./components/arc/foundation.css"');
    expect(tokens).toBeGreaterThan(-1);
    expect(bridge).toBeGreaterThan(tokens);
    const css = globSync("src/web/**/*.css", { cwd: root }).filter(
      (file) => file !== "src/web/index.css",
    );
    const reimported = css.filter((file) => /@import\s+"[^"]*tokens\.css"/.test(read(file)));
    expect(reimported).toEqual([]);
    // Only tokens.css spells out --ew- values; everything else reads them.
    const declared = allWeb
      .filter((file) => file !== "src/web/tokens.css")
      .filter((file) => /(?:^|[\s;{])--ew-[a-z0-9-]+\s*:/m.test(read(file)));
    expect(declared).toEqual([]);
  });

  it("styles the Arc primitives with the console's tokens: --arc- names defined in foundation.css", () => {
    // Arc's bare token names (--accent, --series-*, --text-xl…) mean something else to shadcn and
    // Tailwind, so the Arc sources read --arc- tokens and foundation.css maps each one onto a
    // console token. A file may also use custom properties it declares itself (--badge-color) and
    // the ones Base UI sets on its positioners and tab indicator at runtime.
    const baseUi = new Set([
      "--anchor-width",
      "--available-height",
      "--available-width",
      "--transform-origin",
      "--active-tab-top",
      "--active-tab-left",
      "--active-tab-width",
      "--active-tab-height",
    ]);
    const foundation = read("src/web/components/arc/foundation.css");
    const declared = (source: string) =>
      new Set([...source.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] as string));
    const tokens = declared(foundation);
    expect(tokens.size).toBeGreaterThan(30);
    expect([...tokens].filter((name) => !name.startsWith("--arc-"))).toEqual([]);
    // No accent switch or global focus outline of Arc's own: the accent is the console's blue.
    expect(foundation.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/data-accent|:focus/);
    const arc = allWeb.filter(
      (file) => file.includes("components/arc/") && !file.endsWith("/foundation.css"),
    );
    expect(arc.length).toBeGreaterThan(8);
    // A stylesheet may also read what its component sets in a style object ("--series": color).
    const styled = (file: string) => {
      const component = file.replace(/\.module\.css$/, ".tsx");
      return component !== file && existsSync(resolve(root, component))
        ? [...read(component).matchAll(/"(--[a-z0-9-]+)":/g)].map((m) => m[1] as string)
        : [];
    };
    const unmapped = arc.flatMap((file) => {
      const source = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
      const own = new Set([...declared(source), ...styled(file)]);
      return [...source.matchAll(/var\((--[a-z0-9-]+)/g)]
        .map((m) => m[1] as string)
        .filter(
          (name) =>
            !(name.startsWith("--arc-") ? tokens.has(name) : own.has(name) || baseUi.has(name)),
        )
        .map((name) => `${file}: ${name}`);
    });
    expect(unmapped).toEqual([]);
    // The bridge loads with the console's stylesheet.
    expect(read("src/web/index.css")).toContain('@import "./components/arc/foundation.css"');
  });

  it("takes the Arc primitives from the free registry only, on the console's icons and Motion", () => {
    // Free (MIT) Arc items only; their Lucide icons become Hugeicons, Motion comes through
    // components/effects/motion, Arc's Radix primitives are ported onto Base UI (the console's one
    // headless library), and nothing pulls in Radix or Arc Pro code.
    const arc = webSources.filter((file) => file.includes("components/arc/"));
    const imports = arc.flatMap((file) =>
      [...read(file).matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gms)]
        .map((m) => m[1] as string)
        .filter(
          (spec) =>
            !/^(?:react|@base-ui\/react\/[a-z-]+|@hugeicons\/(?:react|core-free-icons)|@\/(?:components\/effects\/motion|hooks\/use-reduced-motion|lib\/i18n|lib\/utils)|\.{1,2}\/.+)$/.test(
              spec,
            ),
        )
        .map((spec) => `${file}: ${spec}`),
    );
    expect(imports).toEqual([]);
    const components = JSON.parse(read("components.json"));
    expect(components.registries).toEqual({ "@uiarc": "https://uiarc.dev/r/{name}.json" });
    const pro = arc.filter((file) => /uiarc-pro|ARC_PRO_TOKEN/.test(read(file)));
    expect(pro).toEqual([]);
    const radix = webSources.filter((file) => /from\s+"@radix-ui\//.test(read(file)));
    expect(radix).toEqual([]);
    const pkg = JSON.parse(read("package.json"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((name) => name.startsWith("@radix-ui/"))).toEqual([]);
  });
});

/** The `cell:` and `header:` templates of a file's column definitions, as source text. */
function columnTemplates(source: string): string[] {
  const templates: string[] = [];
  for (const match of source.matchAll(/\b(?:cell|header):\s*\(/g)) {
    const arrow = source.indexOf("=>", match.index);
    let depth = 0;
    let end = arrow + 2;
    for (; end < source.length; end++) {
      const char = source[end] as string;
      if ("([{".includes(char)) depth++;
      else if (")]}".includes(char)) {
        if (depth === 0) break;
        depth--;
      } else if (char === "," && depth === 0) break;
    }
    templates.push(source.slice(match.index, end));
  }
  return templates;
}

describe("UI behaviour", () => {
  it("fixes the cascade layer order in index.html before any stylesheet loads", () => {
    // Vite puts a shared chunk of CSS modules (@layer components) ahead of Tailwind's stylesheet;
    // the first stylesheet to name a layer fixes the order, so Tailwind's base reset beat every Arc
    // component's padding (e2e g13: a dialog and its buttons with no padding).
    const html = read("index.html");
    const order = html.indexOf(
      "<style>@layer properties, theme, base, components, utilities;</style>",
    );
    expect(order).toBeGreaterThan(-1);
    expect(order).toBeLessThan(html.indexOf("</head>"));
    expect(html.slice(0, order)).not.toMatch(/<link[^>]+stylesheet|<style/);
  });

  it("renders Arc buttons as type=button unless told otherwise (a button in a form never submits it)", () => {
    // Base UI's Button defaulted to type=button; a bare <button> is a submit button, and the site
    // page's enable toggle saved the name form on every click (e2e p0: a stale-version conflict).
    const button = read("src/web/components/arc/button/button.tsx");
    expect(button).toMatch(/\btype = "button",/);
    expect(button).toMatch(/<motion\.button\s+ref=\{setRefs\}\s+type=\{type\}/);
  });

  it("calls table column templates instead of mounting them (FlexRender remounts cells)", () => {
    const flex = webSources.filter((file) =>
      /import\s*\{[^}]*\b(?:FlexRender|flexRender)\b[^}]*\}\s*from\s*"@tanstack\/react-table"/.test(
        read(file),
      ),
    );
    expect(flex).toEqual([]);
    // Templates are called as plain functions, so a hook in one would run inside DataTable.
    const tables = webSources.filter((file) => read(file).includes("Columns<"));
    const templates = tables.flatMap((file) =>
      columnTemplates(read(file)).map((template) => ({ file, template })),
    );
    expect(templates.length).toBeGreaterThan(50);
    const hooks = templates
      .filter(({ template }) => /\buse[A-Z]\w*\(/.test(template))
      .map(({ file, template }) => `${file}: ${template.split("\n")[0]}`);
    expect(hooks).toEqual([]);
  });

  it("opens list rows from anywhere in the row, not only from their title (lib/row-link)", () => {
    // Every table row runs the row activation: a row whose cells hold a row link opens it.
    const table = read("src/web/components/layout/table.tsx");
    expect(table).toMatch(/onClick=\{\(event\) => \{[^}]*activateRow\(event\)/);
    expect(table).toMatch(/onAuxClick=\{\(event\) => \{[^}]*activateRow\(event\)/);
    // A link to a detail page inside a table is that row's row link, or says it is another one.
    const detailLink = /<(?:Link|LinkButton)\b[^>]*\bto="[^"]*\$[a-z]+[^"]*"[^>]*>/gs;
    const unmarked = webSources
      .filter((file) => /Columns<|<TableRow\b/.test(read(file)))
      .flatMap((file) =>
        [...read(file).matchAll(detailLink)]
          .map((match) => match[0])
          .filter((tag) => !/\{\.\.\.rowLink\}|data-row-ignore/.test(tag))
          .map((tag) => `${file}: ${tag.split("\n")[0]}`),
      );
    expect(unmarked).toEqual([]);
    // The lists whose rows open their details or editor: each keeps a row link, so a whole row or
    // card stays clickable.
    const lists = [
      "src/web/routes/_app/sites/index.tsx",
      "src/web/routes/_app/l4/index.tsx",
      "src/web/routes/_app/alerts.tsx",
      "src/web/routes/_app/dns.tsx",
      "src/web/components/ip-lists.tsx",
      "src/web/components/clusters/nodes.tsx",
      "src/web/components/clusters/node-groups.tsx",
      "src/web/components/regions.tsx",
      "src/web/components/service-accounts.tsx",
      "src/web/routes/_app/certificates.tsx",
      "src/web/components/probes.tsx",
      "src/web/components/site/logs-tab.tsx",
    ];
    const missing = lists.filter((file) => !/\{\.\.\.rowLink\}/.test(read(file)));
    expect(missing).toEqual([]);
  });

  it("shows a query's error only when it never loaded: a failed background refetch keeps the data", () => {
    // TanStack Query v5 sets isError on a failed refetch and keeps the data; isLoadingError is the
    // first load failing. Rendering ErrorState on isError unmounted polled pages, open dialogs
    // and unsaved forms whenever the console restarted.
    const found = webSources.flatMap((file) => {
      const source = read(file);
      const queries = [...source.matchAll(/\bconst (\w+) = use\w*Query\w*\(/g)].map(
        (m) => m[1] as string,
      );
      return [
        ...queries.filter((name) => new RegExp(`\\b${name}\\.isError\\b`).test(source)),
        ...(/\((\w+)\) => \1\.isError\b/.test(source) ? ["(q) => q.isError"] : []),
      ].map((name) => `${file}: ${name}`);
    });
    expect(found).toEqual([]);
  });

  it("renders a query's loading and error states through QueryView", () => {
    // QueryView (components/states.tsx) shows LoadingState on the first load, ErrorState only when
    // that load fails and the empty state; hand-written branches each had to get that right.
    const handWritten = (name: string) =>
      new RegExp(
        `\\b${name}\\.isPending\\b(?:\\s*\\|\\|[^?;]*)?\\s*(?:\\?|&&)\\s*\\(?\\s*(?:<CardContent>\\s*)?<LoadingState\\b` +
          `|if \\([^)]*\\b${name}\\.isPending\\b[^)]*\\)\\s*return\\s*<LoadingState\\b`,
      );
    const found = webSources.flatMap((file) => {
      const source = read(file);
      return [...source.matchAll(/\bconst (\w+) = use\w*Query\w*\(/g)]
        .map((m) => m[1] as string)
        .filter((name) => handWritten(name).test(source))
        .map((name) => `${file}: ${name}`);
    });
    expect(found).toEqual([]);
  });

  it("avoids secure-context-only browser APIs (plain HTTP on a LAN address)", () => {
    // lib/uuid.ts and lib/browser.ts replace crypto.randomUUID and wrap navigator.clipboard.
    const found = allWeb
      .filter((file) => file !== "src/web/lib/browser.ts")
      .filter((file) => /\bcrypto\.randomUUID\(|\bnavigator\.clipboard\b/.test(read(file)));
    expect(found).toEqual([]);
  });
});
