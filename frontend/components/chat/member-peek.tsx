"use client";

import { useMutation } from "convex/react";
import { MessageSquareIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useViewer } from "@/components/auth/account-state";
import { PersonAvatar } from "@/components/people/person-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, type Id } from "@/lib/api";
import { useErrorToast } from "@/lib/errors";
import type { Locale } from "@/lib/locale-store";
import { displayName, localized } from "@/lib/names";

export type PeekMember = {
  _id: Id<"users">;
  name?: string;
  nameZh?: string;
  nameEn?: string;
  email?: string;
  image?: string;
  role?: "presidium" | "lead" | null;
  systemAdmin?: boolean;
  departments?: { nameZh: string; nameEn: string }[];
};

/** Compact member card with Start DM / Open DM from chat members or group info. */
export function MemberPeek({
  member,
  open,
  onOpenChange,
  onOpenedDm,
}: {
  member: PeekMember | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenedDm?: () => void;
}) {
  const t = useTranslations("chat.members");
  const locale = useLocale() as Locale;
  const viewer = useViewer();
  const router = useRouter();
  const showError = useErrorToast();
  const openDm = useMutation(api.channels.getOrCreateDm);
  const [busy, setBusy] = useState(false);
  if (!member) return null;

  const isSelf = member._id === viewer._id;
  const separator = locale === "zh" ? "、" : ", ";
  const depts = (member.departments ?? []).map((d) => localized(d.nameZh, d.nameEn, locale)).join(separator);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <PersonAvatar person={member} className="size-12" />
            <div className="min-w-0">
              <DialogTitle className="truncate">{displayName(member, locale)}</DialogTitle>
              {member.email ? <DialogDescription className="truncate">{member.email}</DialogDescription> : null}
            </div>
          </div>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          {member.role ? (
            <Badge variant={member.role === "presidium" ? "default" : "secondary"}>{t(member.role)}</Badge>
          ) : null}
          {member.systemAdmin ? <Badge variant="outline">{t("systemAdmin")}</Badge> : null}
          {isSelf ? <Badge variant="secondary">{t("you")}</Badge> : null}
        </div>
        {depts ? <p className="text-sm text-muted-foreground">{depts}</p> : null}
        {!isSelf ? (
          <Button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void openDm({ otherUserId: member._id })
                .then((channelId) => {
                  onOpenChange(false);
                  onOpenedDm?.();
                  router.push(`/chat/?c=${channelId}`);
                })
                .catch(showError)
                .finally(() => setBusy(false));
            }}
          >
            <MessageSquareIcon />
            {t("message")}
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
