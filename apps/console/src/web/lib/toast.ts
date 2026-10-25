/*
 * Toasts from anywhere (components, the query client's mutation hooks, pollers): the calls go to
 * the Arc toast stack that <Toaster /> renders once at the root. Calls made before it mounts wait
 * for it.
 */
import type {
  ToastOptions,
  ToastStackApi,
  ToastType,
} from "@/components/arc/toast-stack/toast-stack";

export interface ToastCallOptions {
  /** Reuse an id to update a toast in place. */
  id?: string;
  description?: string;
  /** Milliseconds; loading toasts stay until updated. */
  duration?: number;
  action?: { label: string; onClick: () => void };
  testId?: string;
}

let stack: ToastStackApi | null = null;
const waiting: ToastOptions[] = [];

/** Connects the mounted stack (Toaster); returns the disconnect. */
export function bindToastStack(api: ToastStackApi) {
  stack = api;
  for (const options of waiting.splice(0)) api.toast(options);
  return () => {
    if (stack === api) stack = null;
  };
}

function show(type: ToastType, title: string, options: ToastCallOptions = {}) {
  const { action, ...rest } = options;
  const toastOptions: ToastOptions = {
    ...rest,
    type,
    title,
    action: action ? { label: action.label, onClick: () => action.onClick() } : undefined,
  };
  if (stack) return stack.toast(toastOptions);
  waiting.push(toastOptions);
  return options.id ?? "";
}

export const toast = Object.assign(
  (title: string, options?: ToastCallOptions) => show("info", title, options),
  {
    success: (title: string, options?: ToastCallOptions) => show("success", title, options),
    info: (title: string, options?: ToastCallOptions) => show("info", title, options),
    warning: (title: string, options?: ToastCallOptions) => show("warning", title, options),
    error: (title: string, options?: ToastCallOptions) => show("error", title, options),
    loading: (title: string, options?: ToastCallOptions) => show("loading", title, options),
  },
);
