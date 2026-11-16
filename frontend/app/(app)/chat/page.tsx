"use client";

import { useQuery } from "convex/react";
import { ArrowLeftIcon, SearchIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useState } from "react";
import { ChannelList, OversightList } from "@/components/chat/channel-list";
import { ChatRoom } from "@/components/chat/chat-room";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, type Id } from "@/lib/api";
import { cn } from "@/lib/utils";

export default function ChatPage() {
  return (
    <Suspense>
      <Chat />
    </Suspense>
  );
}

function Chat() {
  const t = useTranslations("chat");
  const params = useSearchParams();
  const requestedId = params.get("c") as Id<"channels"> | null;
  const oversee = params.get("oversee") as Id<"users"> | null;
  const focus = params.get("m") as Id<"messages"> | null;
  const app = params.get("app") as Id<"chatApps"> | null;
  const lists = useQuery(api.channels.listMine);
  const [listQuery, setListQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  // From `md` up (same as the app sidebar), list + conversation sit side by side.
  // Below `md`, the list fills the screen until a chat is opened.
  const activeId = requestedId ?? (oversee ? null : (lists?.org[0]?._id ?? null));
  const detail = useQuery(api.channels.get, activeId ? { channelId: activeId } : "skip");
  const showConversationOnMobile = requestedId !== null;
  const backHref = oversee ? `/chat/?oversee=${oversee}` : "/chat/";

  return (
    <div className="flex min-h-0 flex-1">
      <div
        className={cn(
          "min-h-0 w-full min-w-0 flex-col overflow-hidden border-r border-border md:flex md:w-72 md:shrink-0",
          showConversationOnMobile ? "hidden" : "flex",
        )}
      >
        {oversee ? (
          <OversightList userId={oversee} activeId={activeId} />
        ) : (
          <>
            <PageHeader
              title={
                searchOpen ? (
                  <Input
                    autoFocus
                    value={listQuery}
                    onChange={(e) => setListQuery(e.target.value)}
                    placeholder={t("searchList")}
                    aria-label={t("searchList")}
                    className="h-8"
                  />
                ) : (
                  t("title")
                )
              }
            >
              {searchOpen ? (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("close")}
                  onClick={() => {
                    setSearchOpen(false);
                    setListQuery("");
                  }}
                >
                  <XIcon />
                </Button>
              ) : (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("searchList")}
                  onClick={() => setSearchOpen(true)}
                >
                  <SearchIcon />
                </Button>
              )}
            </PageHeader>
            {lists ? <ChannelList lists={lists} activeId={activeId} filter={listQuery} /> : null}
          </>
        )}
      </div>
      <section
        className={cn("min-h-0 min-w-0 flex-1 flex-col md:flex", showConversationOnMobile ? "flex" : "hidden")}
      >
        {detail ? (
          <ChatRoom
            key={`${detail._id}:${focus ?? ""}:${app ?? ""}`}
            channel={detail}
            backHref={backHref}
            initialFocus={focus}
            initialApp={app}
          />
        ) : detail === null ? (
          <NoAccess backHref={backHref} />
        ) : (
          <p className="m-auto text-sm text-muted-foreground">{lists && !activeId ? t("selectChannel") : null}</p>
        )}
      </section>
    </div>
  );
}

function NoAccess({ backHref }: { backHref: string }) {
  const t = useTranslations("chat");
  return (
    <div className="m-auto flex flex-col items-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">{t("noAccess")}</p>
      <Button asChild size="sm" variant="secondary">
        <Link href={backHref}>
          <ArrowLeftIcon />
          {t("backToChats")}
        </Link>
      </Button>
    </div>
  );
}
