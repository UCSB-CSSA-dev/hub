"use client";

import { MoonIcon, SunIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { LanguageToggle } from "@/components/layout/language-toggle";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { FONT_SIZES } from "@/lib/font-size";
import { setStoredFontSize, useStoredFontSize } from "@/lib/font-size-store";
import { setStoredTheme, useStoredTheme } from "@/lib/theme-store";
import { SettingRow } from "./setting-row";

export function AppearanceCard() {
  const t = useTranslations("settings");
  const theme = useStoredTheme();
  const fontSize = useStoredFontSize();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("display")}</CardTitle>
      </CardHeader>
      <CardContent className="divide-y divide-border">
        <SettingRow label={t("language")}>
          <LanguageToggle full />
        </SettingRow>
        <SettingRow label={t("theme")}>
          <Segmented
            label={t("theme")}
            value={theme}
            onChange={setStoredTheme}
            options={[
              { value: "light", label: <><SunIcon />{t("themeLight")}</> },
              { value: "dark", label: <><MoonIcon />{t("themeDark")}</> },
            ]}
          />
        </SettingRow>
        <SettingRow label={t("fontSize")} hint={t("fontSizeHint")}>
          <Segmented
            label={t("fontSize")}
            value={fontSize}
            onChange={setStoredFontSize}
            options={FONT_SIZES.map((value) => ({ value, label: t(`fontSizes.${value}`) }))}
          />
        </SettingRow>
      </CardContent>
    </Card>
  );
}
