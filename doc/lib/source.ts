import { loader } from "fumadocs-core/source";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineDocs } from "fumadocs-mdx/macro";
import sources from "@/content/sources.json";
import { i18n } from "./i18n";

const docs = defineDocs({
  dir: "content/docs",
  docs: { schema: pageSchema },
  meta: { schema: metaSchema },
});

export const source = loader({
  baseUrl: "/",
  i18n,
  source: docs.toFumadocsSource(),
});

/** GitHub URL of the Markdown file a page was generated from. */
export function sourceUrl(path: string): string | undefined {
  return (sources as Record<string, string>)[path];
}
