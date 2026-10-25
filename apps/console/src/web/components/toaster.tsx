/*
 * The app's one toast stack (Arc's toast-stack); lib/toast.ts sends toasts to it. It renders beside
 * the router, so it brings its own Motion settings (the light components need LazyMotion).
 */
import * as React from "react";
import {
  ToastStack,
  ToastStackProvider,
  useToastStack,
} from "@/components/arc/toast-stack/toast-stack";
import { MotionSettings } from "@/components/effects/motion-config";
import { bindToastStack } from "@/lib/toast";

function Bind() {
  const { toast, update, dismiss } = useToastStack();
  React.useEffect(() => bindToastStack({ toast, update, dismiss }), [toast, update, dismiss]);
  return null;
}

export function Toaster() {
  return (
    <MotionSettings>
      <ToastStackProvider>
        <Bind />
        <ToastStack />
      </ToastStackProvider>
    </MotionSettings>
  );
}
