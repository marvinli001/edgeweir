import * as React from "react";

/**
 * A page's tab bar (line tabs over a hairline) that scrolls sideways on phones; give its TabsList
 * `scroll-fade` and the returned ref. The edges that hide more tabs fade out ([data-fade]), so a
 * phone shows that the bar scrolls; the active tab (the one whose data-testid is `activeTestId`)
 * and a tab that takes keyboard focus scroll clear of the fades.
 */
export function useTabBar(activeTestId: string) {
  const [list, setList] = React.useState<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!list) return;
    const mark = () => {
      const start = list.scrollLeft > 1;
      const end = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
      if (start || end) list.dataset.fade = start && end ? "both" : start ? "start" : "end";
      else delete list.dataset.fade;
    };
    const focus = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && event.target !== list)
        revealTab(list, event.target);
    };
    mark();
    list.addEventListener("scroll", mark, { passive: true });
    list.addEventListener("focusin", focus);
    const observer = new ResizeObserver(mark);
    observer.observe(list);
    return () => {
      list.removeEventListener("scroll", mark);
      list.removeEventListener("focusin", focus);
      observer.disconnect();
    };
  }, [list]);
  React.useEffect(() => {
    if (!list) return;
    const reveal = () => {
      const active = list.querySelector<HTMLElement>(`[data-testid="${activeTestId}"]`);
      if (active) revealTab(list, active);
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    return () => observer.disconnect();
  }, [list, activeTestId]);
  return setList;
}

/**
 * Scrolls a tab of the tab bar into view with the bar's scroll padding (the scroll-fade width)
 * between it and either edge, so the active or focused tab never sits under a faded edge: its
 * label keeps full contrast and its indicator stays whole. At the ends of the bar the scroll
 * stops short of the padding, and an edge with nothing beyond it does not fade.
 */
function revealTab(list: HTMLElement, tab: HTMLElement) {
  const style = getComputedStyle(list);
  const start = Number.parseFloat(style.scrollPaddingInlineStart) || 0;
  const end = Number.parseFloat(style.scrollPaddingInlineEnd) || 0;
  const bounds = list.getBoundingClientRect(),
    item = tab.getBoundingClientRect();
  if (item.left < bounds.left + start) list.scrollLeft += item.left - bounds.left - start;
  else if (item.right > bounds.right - end) list.scrollLeft += item.right - bounds.right + end;
}
