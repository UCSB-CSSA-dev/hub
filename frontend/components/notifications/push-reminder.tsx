"use client";

import { BellIcon, BellOffIcon, SmartphoneIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { IosGuideDialog, useEnablePush } from "@/components/settings/push-notifications-card";
import { Button } from "@/components/ui/button";

/**
 * Shown on the notifications page while this device can't get push notifications, e.g. after the
 * iPhone home-screen app was removed and re-added, which starts it with notifications off.
 */
export function PushReminder() {
  const t = useTranslations("notifications");
  const { push, busy, enable } = useEnablePush();
  const [guideOpen, setGuideOpen] = useState(false);

  if (push.configured !== true) return null;
  if (push.state !== "off" && push.state !== "ios-install" && push.state !== "denied") return null;

  const guide = (
    <Button size="sm" variant={push.state === "ios-install" ? "default" : "ghost"} onClick={() => setGuideOpen(true)}>
      <SmartphoneIcon />
      {t("pushReminderGuide")}
    </Button>
  );

  return (
    <div className="mb-3 flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
      <div className="flex items-start gap-2.5">
        <BellOffIcon className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("pushReminderTitle")}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(
              push.state === "ios-install"
                ? "pushReminderIos"
                : push.state === "denied"
                  ? "pushReminderDenied"
                  : "pushReminderOff",
            )}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-6.5">
        {push.state === "off" ? (
          <Button size="sm" onClick={() => void enable()} disabled={busy}>
            <BellIcon />
            {t("pushReminderEnable")}
          </Button>
        ) : null}
        {guide}
        <Button asChild size="sm" variant="ghost">
          <Link href="/settings/?tab=notifications">{t("pushReminderSettings")}</Link>
        </Button>
      </div>
      <IosGuideDialog open={guideOpen} onOpenChange={setGuideOpen} />
    </div>
  );
}
