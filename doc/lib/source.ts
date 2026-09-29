import { loader } from "fumadocs-core/source";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineDocs } from "fumadocs-mdx/macro";
import sources from "@/content/sources.json";
import { i18n } from "./i18n";
import { branch, repository } from "./site";

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
  const file = (sources as Record<string, string>)[path];
  return file ? `${repository}/blob/${branch}/${file}` : undefined;
}
