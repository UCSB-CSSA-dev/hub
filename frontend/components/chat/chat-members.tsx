"use client";

import { useQuery } from "convex/react";
import { UsersRoundIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { PersonAvatar } from "@/components/people/person-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import type { Locale } from "@/lib/locale-store";
import { displayName, localized } from "@/lib/names";
import { useChat } from "./chat-context";

const SEARCH_FROM = 12;

/** Header button listing everyone in the chat: a centered dialog on phones, a right-hand panel on wider screens. */
export function ChatMembersButton() {
  const t = useTranslations("chat.members");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="icon-sm" variant="ghost" aria-label={t("title")} title={t("title")} onClick={() => setOpen(true)}>
        <UsersRoundIcon />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[80dvh] flex-col md:inset-y-0 md:right-0 md:left-auto md:h-dvh md:max-h-none md:w-80 md:max-w-80 md:translate-x-0 md:translate-y-0 md:rounded-none md:data-open:slide-in-from-right-10 md:data-open:zoom-in-100">
          {open ? <MembersList /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function MembersList() {
  const t = useTranslations("chat.members");
  const locale = useLocale() as Locale;
  const { channel } = useChat();
  const members = useQuery(api.channels.members, { channelId: channel._id });
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown = (members ?? []).filter(
    (m) =>
      !needle ||
      [m.nameZh, m.nameEn, m.name, m.email].some((value) => value?.toLowerCase().includes(needle)),
  );
  const separator = locale === "zh" ? "、" : ", ";

  return (
    <>
      <DialogHeader>
        <DialogTitle>{members ? t("titleCount", { count: members.length }) : t("title")}</DialogTitle>
      </DialogHeader>
      {members && members.length >= SEARCH_FROM ? (
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("search")} aria-label={t("search")} />
      ) : null}
      <ScrollArea className="-mx-4 min-h-0 flex-1">
        <ul className="flex flex-col px-2">
          {members === undefined
            ? Array.from({ length: 4 }, (_, i) => (
                <li key={i} className="flex items-center gap-3 px-2 py-2">
                  <Skeleton className="size-8 rounded-full" />
                  <Skeleton className="h-4 w-28" />
                </li>
              ))
            : shown.map((member) => (
                <li key={member._id} className="flex items-center gap-3 rounded-md px-2 py-2">
                  <PersonAvatar person={member} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{displayName(member, locale)}</p>
                    {member.role === "lead" && member.departments.length > 0 ? (
                      <p className="truncate text-xs text-muted-foreground">
                        {member.departments.map((d) => localized(d.nameZh, d.nameEn, locale)).join(separator)}
                      </p>
                    ) : null}
                  </div>
                  {member.role ? (
                    <Badge variant={member.role === "presidium" ? "default" : "secondary"} className="shrink-0">
                      {t(member.role)}
                    </Badge>
                  ) : null}
                  {member.systemAdmin ? (
                    <Badge variant="outline" className="shrink-0">
                      {t("systemAdmin")}
                    </Badge>
                  ) : null}
                </li>
              ))}
          {members && shown.length === 0 ? (
            <li className="px-2 py-4 text-center text-sm text-muted-foreground">{t("none")}</li>
          ) : null}
        </ul>
      </ScrollArea>
    </>
  );
}
