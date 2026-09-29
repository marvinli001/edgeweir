import { createFromSource } from "fumadocs-core/search/server";
import { i18n } from "@/lib/i18n";
import { source } from "@/lib/source";

export const revalidate = false;
export const dynamicParams = false;

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}

/** A page shown in another language because its translation is missing. */
function isFallback(page: { path: string }, lang: string): boolean {
  return lang !== i18n.defaultLanguage && !page.path.endsWith(`.${lang}.mdx`);
}

// One index per language, each page indexed once in the language it is written
// in, so a reader downloads only the index of the language being read.
const servers = Object.fromEntries(
  i18n.languages.map((lang) => [
    lang,
    createFromSource({
      ...source,
      _i18n: undefined,
      getPages: () => source.getPages(lang).filter((page) => !isFallback(page, lang)),
    }),
  ]),
);

export async function GET(_request: Request, { params }: RouteContext<"/api/search/[lang]">) {
  const { lang } = await params;
  return servers[lang].staticGET();
}
