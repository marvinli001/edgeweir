"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** `/` has no page: go to the documentation in the browser's language. */
export function LanguageRedirect() {
  const router = useRouter();
  useEffect(() => {
    const zh = navigator.languages.some((l) => l.toLowerCase().startsWith("zh"));
    router.replace(zh ? "/zh/" : "/en/");
  }, [router]);
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <Link href="/zh/">简体中文</Link> · <Link href="/en/">English</Link>
    </main>
  );
}
