"use client";

import { useConvexAuth, useMutation } from "convex/react";
import { useTranslations } from "next-intl";
import { Segmented } from "@/components/ui/segmented";
import { api } from "@/lib/api";
import { setStoredLocale, useStoredLocale, type Locale } from "@/lib/locale-store";

const SHORT: Record<Locale, string> = { zh: "中", en: "EN" };
const FULL: Record<Locale, string> = { zh: "中文", en: "English" };

export function LanguageToggle({ className, full = false }: { className?: string; full?: boolean }) {
  const t = useTranslations("nav");
  const locale = useStoredLocale();
  const { isAuthenticated } = useConvexAuth();
  const saveLocale = useMutation(api.users.setLocale);

  const choose = (next: Locale) => {
    setStoredLocale(next);
    if (isAuthenticated) void saveLocale({ locale: next }).catch(() => undefined);
  };

  return (
    <Segmented
      label={t("language")}
      value={locale}
      onChange={choose}
      className={className}
      options={(["zh", "en"] as const).map((value) => ({ value, label: (full ? FULL : SHORT)[value] }))}
    />
  );
}
