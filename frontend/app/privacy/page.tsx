"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { BrandMark } from "@/components/layout/brand";
import { LanguageToggle } from "@/components/layout/language-toggle";
import { ThemeToggle } from "@/components/layout/theme-toggle";

const SECTIONS = ["use", "oversight", "ai", "storage", "delete", "contact"] as const;

/** Public page (no sign-in), linked from Google's OAuth consent screen. */
export default function PrivacyPage() {
  const t = useTranslations("privacy");
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-10 text-sm leading-relaxed">
      <div className="flex items-center justify-between">
        <Link href="/">
          <BrandMark className="h-10" />
        </Link>
        <div className="flex items-center gap-2"><ThemeToggle /><LanguageToggle /></div>
      </div>
      <header>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="mt-1 text-muted-foreground">{t("updated")}</p>
      </header>
      <p>{t("intro")}</p>
      <section>
        <h2 className="mb-2 text-base font-semibold text-primary">{t("collectTitle")}</h2>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>{t("collectGoogle")}</li>
          <li>{t("collectProfile")}</li>
          <li>{t("collectContent")}</li>
        </ul>
      </section>
      {SECTIONS.map((key) => (
        <section key={key}>
          <h2 className="mb-2 text-base font-semibold text-primary">{t(`${key}Title`)}</h2>
          <p>{t(`${key}Body`)}</p>
        </section>
      ))}
    </main>
  );
}
