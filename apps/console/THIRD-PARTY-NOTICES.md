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
| `spotlight.tsx`, `tilt.tsx` | [Motion Primitives](https://github.com/ibelick/motion-primitives) (`spotlight`, `tilt`) | `120f64f6ca60` (2026-10-06) | Copyright (c) 2024 ibelick | MIT |
| `animated-beam.tsx` | [Magic UI](https://github.com/magicuidesign/magicui) (`animated-beam`) | `cdb348cb4c72` (2026-10-06) | Copyright (c) Magic UI | MIT |
| `emboss-surface.tsx` | [Smooth UI](https://github.com/educlopez/smoothui) (`emboss-surface`) | `b6312bce2b6f` (2026-10-06) | Copyright (c) 2024 Eduardo Calvo | MIT |
| `origin-topology.tsx` (node, handle and animated edge) | [React Flow UI](https://reactflow.dev/ui) (`base-node`, `base-handle`, `animated-svg-edge`), in [xyflow](https://github.com/xyflow/xyflow) | `3d35b5731757` (2026-10-06) | Copyright (c) 2019-2025 webkid GmbH | MIT |
| `animated-icons.tsx` | [hugeicons-animated](https://github.com/enesgules/hugeicons-animated) (`dashboard-square-01`, `notification-03`, `sliders-horizontal`, `list-view`, `inbox`, `use-icon-animation`) | `5d3fcbef342d` (2026-10-06) | Copyright (c) 2026 Abdullah Enes Gules; glyphs from the Hugeicons free set (MIT) | MIT |
| `world-dots.ts` (generated) | [dotted-map](https://github.com/NTag/dotted-map) 3.1.0 with its bundled Natural Earth land data (public domain) | 3.1.0 | Copyright (c) 2021 Basile Bruneau | MIT |

## Bundled packages

| Package | Version | Copyright | License |
| --- | --- | --- | --- |
| [cobe](https://github.com/shuding/cobe) | 2.0.1 | Copyright (c) 2021 Shu Ding | MIT |
| [@xyflow/react](https://github.com/xyflow/xyflow) | 12.12.0 | Copyright (c) 2019-2025 webkid GmbH | MIT |
| [@dagrejs/dagre](https://github.com/dagrejs/dagre) | 3.1.1 | Copyright (c) 2012-2014 Chris Pettitt | MIT |
| [uPlot](https://github.com/leeoniya/uPlot) | 1.6.32 | Copyright (c) 2022 Leon Sorokin | MIT |
| [@number-flow/react](https://github.com/barvian/number-flow) | 0.6.2 | Copyright (c) 2024 Maxwell Barvian | MIT |
| [motion](https://github.com/motiondivision/motion) | 13.5.1 (shared with appica-ui) | Copyright (c) 2024 Motion B.V. | MIT |
| [@paper-design/shaders-react](https://github.com/paper-design/shaders) | 0.0.81 | Copyright 2026 Paper | Apache-2.0 (NOTICE below) |

Paper Shaders `NOTICE`:

```text
Paper Shaders
Copyright 2026 Paper

Powered by Paper Shaders:
https://shaders.paper.design
```

## Fonts (self-hosted, SIL Open Font License 1.1)

| Font | Package | Copyright |
| --- | --- | --- |
| Geist | `@fontsource-variable/geist` 5.3.0 | Copyright 2024 The Geist Project Authors |
| Mona Sans | `@fontsource-variable/mona-sans` 5.3.0 | Copyright 2022 The Mona Sans Project Authors, Reserved Font Name "Mona" |
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
