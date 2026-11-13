import { useLocale, useTranslations } from "next-intl";
import { useCallback } from "react";
import { useViewer } from "@/components/auth/account-state";
import type { Locale } from "@/lib/locale-store";
import { channelName, type Channel } from "./types";

export function useChannelName() {
  const t = useTranslations("chat");
  const locale = useLocale() as Locale;
  const viewer = useViewer();
  return useCallback(
    (channel: Pick<Channel, "type" | "nameZh" | "nameEn" | "name" | "otherUser" | "dmUsers">) =>
      channelName(
        channel,
        locale,
        {
          general: t("general"),
          orgAnnouncements: t("orgAnnouncements"),
          announcementOf: (department) => t("announcementOf", { department }),
          sasa: t("sasaChat"),
          sasaOf: (owner) => t("sasaChatOf", { owner }),
        },
        viewer._id,
      ),
    [t, locale, viewer._id],
  );
}
