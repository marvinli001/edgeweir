import { i18nProvider } from "fumadocs-ui/i18n";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Provider } from "@/components/provider";
import { mono, sans } from "@/lib/fonts";
import { htmlLang, i18n, type Lang } from "@/lib/i18n";
import { baseOptions, translations } from "@/lib/layout.shared";
import { siteName } from "@/lib/site";
import { source } from "@/lib/source";
import "../global.css";

export const dynamicParams = false;

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  return {
    title: { template: `%s | ${siteName}`, default: siteName },
    description:
      lang === "zh"
        ? "自托管 CDN / WAF / 边缘调度控制平面的部署与使用文档。"
        : "Deployment and operations documentation for the self-hosted CDN / WAF / edge scheduling control plane.",
  };
}

export default async function Layout({
  params,
  children,
}: {
  params: Promise<{ lang: string }>;
  children: ReactNode;
}) {
  const lang = (await params).lang as Lang;
  return (
    <html
      lang={htmlLang[lang]}
      className={`${sans.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col">
        <Provider i18n={i18nProvider(translations, lang)}>
          <DocsLayout tree={source.getPageTree(lang)} {...baseOptions(lang)}>
            {children}
          </DocsLayout>
        </Provider>
      </body>
    </html>
  );
}
