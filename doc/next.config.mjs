import { createMDX } from "fumadocs-mdx/next";

// GitHub Pages serves the project site under /<repository>; the workflow sets
// DOCS_BASE_PATH=/edgeweir. Local builds serve from the root.
const basePath = process.env.DOCS_BASE_PATH ?? "";

/** @type {import('next').NextConfig} */
const config = {
  output: "export",
  basePath,
  trailingSlash: true,
  reactStrictMode: true,
  images: { unoptimized: true },
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};

export default createMDX()(config);
