import { uiTranslations } from "fumadocs-ui/i18n";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { i18n, type Lang } from "./i18n";
import { repository, siteName } from "./site";

export const translations = i18n
  .translations()
  .extend(uiTranslations())
  .add({
    zh: {
      displayName: "简体中文",
      "Search(search trigger)": "搜索",
      "Search(search dialog)": "搜索文档",
      "Open Search(search trigger)(aria-label)": "打开搜索",
      "Close Search(search dialog)(aria-label)": "关闭搜索",
      "No results found(search dialog)": "无结果",
      "On this page(table of contents)": "本页目录",
      "No Headings(table of contents)": "无标题",
      "Table of Contents(inline table of contents)": "目录",
      "Edit on GitHub(edit page)": "在 GitHub 上编辑",
      "Last updated on(page footer)": "最后更新",
      "Next Page(pagination)": "下一页",
      "Previous Page(pagination)": "上一页",
      "Choose a language(language switcher)": "选择语言",
      "Choose a language(language switcher)(aria-label)": "选择语言",
      "Toggle Theme(theme switcher)(aria-label)": "切换主题",
      "Light(theme switcher)(aria-label)": "浅色",
      "Dark(theme switcher)(aria-label)": "深色",
      "System(theme switcher)(aria-label)": "跟随系统",
      "Open Sidebar(aria-label)": "打开侧边栏",
      "Close Sidebar(aria-label)": "关闭侧边栏",
      "Open Sidebar(sidebar)(aria-label)": "打开侧边栏",
      "Close Sidebar(sidebar)(aria-label)": "关闭侧边栏",
      "Collapse Sidebar(sidebar)(aria-label)": "收起侧边栏",
      "Hide Sidebar(sidebar)": "隐藏侧边栏",
      "Show Sidebar(sidebar)": "显示侧边栏",
      "Toggle Menu(home layout header)(aria-label)": "切换菜单",
      "Copy Text(code block)(aria-label)": "复制",
      "Copied Text(code block)(aria-label)": "已复制",
      "Copy Anchor Link(heading anchor)(aria-label)": "复制链接",
      "Copied Anchor Link(heading anchor)(aria-label)": "已复制链接",
      "Page Not Found(404 not found page)": "页面不存在",
      "Back to Home(404 not found page)": "返回首页",
    },
    en: {
      displayName: "English",
    },
  });

export function baseOptions(lang: Lang): BaseLayoutProps {
  return {
    nav: {
      title: <span className="font-semibold tracking-tight">{siteName}</span>,
      url: `/${lang}`,
    },
    githubUrl: repository,
  };
}
