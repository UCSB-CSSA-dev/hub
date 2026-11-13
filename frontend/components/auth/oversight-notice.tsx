"use client";

import { EyeIcon } from "lucide-react";
import { useTranslations } from "next-intl";

/** The oversight and data disclosure shown at signup (and again when it changes) and in settings. */
export function OversightNotice() {
  const t = useTranslations("onboarding");
  return (
    <section className="rounded-lg border border-primary/40 bg-primary/5 p-4 text-sm">
      <h2 className="mb-2 flex items-center gap-2 font-semibold text-primary">
        <EyeIcon className="size-4" />
        {t("noticeTitle")}
      </h2>
      <p className="mb-2 text-muted-foreground">{t("noticeIntro")}</p>
      <ul className="list-disc space-y-1.5 pl-5">
        <li>{t("noticePresidium")}</li>
        <li>{t("noticeLead")}</li>
        <li>{t("noticeIcon")}</li>
        <li>{t("noticeAudit")}</li>
        <li>{t("noticePrivate")}</li>
      </ul>
      <h3 className="mt-3 mb-1.5 font-medium">{t("noticeDataTitle")}</h3>
      <ul className="list-disc space-y-1.5 pl-5 text-muted-foreground">
        <li>{t("noticeRetention")}</li>
        <li>{t("noticeRecall")}</li>
        <li>{t("noticeFiles")}</li>
        <li>{t("noticeProfile")}</li>
        <li>{t("noticeAi")}</li>
      </ul>
    </section>
  );
}
