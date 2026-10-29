# Third-party notices (console web UI)

The console's web UI includes source code adapted from the projects below and bundles the
packages and fonts listed after them. Their licenses permit redistribution under the console's
AGPL-3.0-only license; each one's copyright notice and license are kept here. Packages installed
from npm also carry their own license files in `node_modules`.

## Adapted source code

Copied into `src/web/components/effects/` and changed as described in each file's header
(token colors instead of literals, reduced-motion and off-screen handling, Paraglide text,
Hugeicons). MIT license text below.

| Code | From | Version | Copyright | License |
| --- | --- | --- | --- | --- |
| `origin-topology.tsx` (node, handle and animated edge) | [React Flow UI](https://reactflow.dev/ui) (`base-node`, `base-handle`, `animated-svg-edge`), in [xyflow](https://github.com/xyflow/xyflow) | `3d35b5731757` (2026-10-06) | Copyright (c) 2019-2025 webkid GmbH | MIT |
| `world-dots.ts` (generated) | [dotted-map](https://github.com/NTag/dotted-map) 3.1.0 with its bundled Natural Earth land data (public domain) | 3.1.0 | Copyright (c) 2021 Basile Bruneau | MIT |

Arc primitives: copied into `src/web/components/arc/` from Arc's public registry (free tier only)
and changed as described in each file's header (`--arc-` tokens mapped onto the console's in
`foundation.css`, Motion's light components, Hugeicons, Paraglide text). Arc builds its dialog,
menu, select, tabs, switch, checkbox, tooltip and drawer on Radix; those are ported from Arc with
the primitives switched to Base UI, keeping Arc's styling and motion. MIT license text below.

| Code | From | Version | Copyright | License |
| --- | --- | --- | --- | --- |
| `foundation.css`, `motion-tokens.ts`, `arc-provider.tsx`, `button.tsx`, `badge.tsx`, `alert.tsx`, `avatar.tsx`, `progress.tsx`, `toast-stack.tsx` | [Arc](https://github.com/kuratlielia/arc-library) (`arc-foundation`, `arc-motion-tokens`, `button`, `badge`, `alert`, `avatar`, `progress`, `toast-stack`) | registry (2026-10-25) | Copyright (c) 2026 Elia Kuratli | MIT |
| `input.tsx`, `input.module.css`, `textarea.tsx`, `textarea.module.css`, `switch.tsx`, `switch.module.css`, `checkbox.tsx`, `checkbox.module.css`, `tabs.tsx`, `tabs.module.css`, `tooltip.tsx`, `tooltip.module.css`, `dropdown-menu.tsx`, `dropdown-menu.module.css`, `select.tsx`, `select.module.css`, `dialog.tsx`, `dialog.module.css` (ported from Arc, primitives switched to Base UI) | [Arc](https://github.com/kuratlielia/arc-library) (`input`, `textarea`, `switch`, `checkbox`, `tabs`, `tooltip`, `dropdown-menu`, `select`, `dialog`) | registry (2026-10-25) | Copyright (c) 2026 Elia Kuratli | MIT |
| `animated-counter.tsx`, `animated-counter.module.css`, `command-palette.tsx`, `command-palette.module.css`, `drawer.tsx`, `drawer.module.css`, `empty-state.tsx`, `empty-state.module.css`, `line-chart.tsx`, `line-chart.module.css`, `metric-card.tsx`, `metric-card.module.css`, `otp-input.tsx`, `otp-input.module.css`, `pagination.tsx`, `pagination.module.css`, `scroll-area.tsx`, `scroll-area.module.css`, `sparkline.tsx`, `sparkline.module.css` (the drawer ported to Base UI Dialog) | [Arc](https://github.com/kuratlielia/arc-library) (`animated-counter`, `command-palette`, `drawer`, `empty-state`, `line-chart`, `metric-card`, `otp-input`, `pagination`, `scroll-area`, `sparkline`) | registry (2026-10-29) | Copyright (c) 2026 Elia Kuratli | MIT |

## Bundled packages

| Package | Version | Copyright | License |
| --- | --- | --- | --- |
| [cobe](https://github.com/shuding/cobe) | 2.0.1 | Copyright (c) 2021 Shu Ding | MIT |
| [@xyflow/react](https://github.com/xyflow/xyflow) | 12.12.0 | Copyright (c) 2019-2025 webkid GmbH | MIT |
| [@dagrejs/dagre](https://github.com/dagrejs/dagre) | 3.1.1 | Copyright (c) 2012-2014 Chris Pettitt | MIT |
| [uPlot](https://github.com/leeoniya/uPlot) | 1.6.32 | Copyright (c) 2022 Leon Sorokin | MIT |
| [@number-flow/react](https://github.com/barvian/number-flow) | 0.6.2 | Copyright (c) 2024 Maxwell Barvian | MIT |
| [motion](https://github.com/motiondivision/motion) | 13.5.1 | Copyright (c) 2024 Motion B.V. | MIT |

## Fonts (self-hosted, SIL Open Font License 1.1)

| Font | Package | Copyright |
| --- | --- | --- |
| Inter | `@fontsource-variable/inter` 5.3.0 | Copyright 2020 The Inter Project Authors |
| Noto Sans SC | `@fontsource-variable/noto-sans-sc` 5.3.0 (Google Fonts v40) | Google Inc. |

The fonts are used unmodified (the packages' `unicode-range` shards).

## MIT License

```text
Permission is hereby granted, free of charge, to any person obtaining a copy of this software
and associated documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

The Apache License 2.0 and the SIL Open Font License 1.1 are included in the respective
packages (`LICENSE`).
