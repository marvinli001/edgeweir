import { createFileRoute, useLocation } from "@tanstack/react-router";
import { NotFoundPage } from "@/components/status-page";

/** Any path no page serves: the not-found page inside the console (after the session check). */
export const Route = createFileRoute("/_app/$")({
  component: NotFound,
});

function NotFound() {
  const href = useLocation({ select: (location) => location.href });
  return <NotFoundPage path={href} surface="shell" />;
}
