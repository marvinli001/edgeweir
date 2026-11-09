import { Callout } from "fumadocs-ui/components/callout";
import { Card, Cards } from "fumadocs-ui/components/card";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import Image, { type ImageProps } from "next/image";

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    img: (props) => {
      const image = props as ImageProps;
      const src = image.src;
      const href = typeof src === "string" ? src : "default" in src ? src.default.src : src.src;
      return (
        <a href={href} target="_blank" rel="noreferrer">
          <Image {...image} />
        </a>
      );
    },
    Callout,
    Card,
    Cards,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
