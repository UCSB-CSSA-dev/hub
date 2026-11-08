"use client";

import { BellIcon, SlidersHorizontalIcon, UserRoundIcon, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense } from "react";
import { useViewer } from "@/components/auth/account-state";
import { OversightNotice } from "@/components/auth/oversight-notice";
import { PageHeader } from "@/components/layout/app-shell";
import { AppearanceCard } from "@/components/settings/appearance-card";
import { DeactivateCard } from "@/components/settings/deactivate-card";
import { DeviceFilesCard } from "@/components/settings/device-files-card";
import { DigestEmailCard } from "@/components/settings/digest-email-card";
import { ProfileCard } from "@/components/settings/profile-card";
import { PushNotificationsCard } from "@/components/settings/push-notifications-card";
import { WhoCanSeeCard } from "@/components/settings/who-can-see-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useSignOut } from "@/lib/push";
import { cn } from "@/lib/utils";

type Tab = "personal" | "notifications" | "general";
const TABS: { key: Tab; icon: LucideIcon }[] = [
  { key: "personal", icon: UserRoundIcon },
  { key: "notifications", icon: BellIcon },
  { key: "general", icon: SlidersHorizontalIcon },
];

export default function SettingsPage() {
  const t = useTranslations("settings");
  return (
    <>
      <PageHeader title={t("title")} />
      <Suspense>
        <SettingsTabs />
      </Suspense>
    </>
  );
}

function SettingsTabs() {
  const t = useTranslations("settings");
  const param = useSearchParams().get("tab");
  const tab = TABS.find(({ key }) => key === param)?.key ?? "personal";

  return (
    <>
      <nav aria-label={t("title")} className="flex shrink-0 gap-1 border-b border-border px-3 py-2">
        {TABS.map(({ key, icon: Icon }) => (
          <Link
            key={key}
            href={key === "personal" ? "/settings/" : `/settings/?tab=${key}`}
            replace
            aria-current={tab === key ? "page" : undefined}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors md:max-w-40 md:flex-none md:px-4",
              tab === key ? "bg-accent text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {t(`tabs.${key}`)}
          </Link>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
          {tab === "personal" ? <PersonalTab /> : tab === "notifications" ? <NotificationsTab /> : <GeneralTab />}
        </div>
      </div>
    </>
  );
}

function PersonalTab() {
  const t = useTranslations();
  const viewer = useViewer();
  const signOut = useSignOut();
  return (
    <>
      <ProfileCard />
      <Card>
        <CardHeader>
          <CardTitle>{t("settings.account")}</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate text-sm text-muted-foreground">
            {t("settings.signedInAs", { email: viewer.email ?? "" })}
          </span>
          <Button variant="outline" onClick={() => void signOut()}>
            {t("common.signOut")}
          </Button>
        </CardContent>
      </Card>
      <WhoCanSeeCard />
      <OversightNotice />
      <DeactivateCard />
    </>
  );
}

function NotificationsTab() {
  return (
    <>
      <PushNotificationsCard />
      <DigestEmailCard />
    </>
  );
}

function GeneralTab() {
  return (
    <>
      <AppearanceCard />
      <DeviceFilesCard />
    </>
  );
}
