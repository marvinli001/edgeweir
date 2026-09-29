import type { Metadata } from "next";
import { LanguageRedirect } from "./redirect";

export const metadata: Metadata = { title: "Edgeweir" };

export default function Page() {
  return <LanguageRedirect />;
}
