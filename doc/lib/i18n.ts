import { defineI18n } from "fumadocs-core/i18n";

export const i18n = defineI18n({
  defaultLanguage: "zh",
  languages: ["zh", "en"],
  hideLocale: "never",
  parser: "dot",
});

export type Lang = (typeof i18n.languages)[number];

/** BCP 47 tag for <html lang>. */
export const htmlLang: Record<Lang, string> = { zh: "zh-CN", en: "en" };
