"use client";

import { useQuery } from "convex/react";
import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense } from "react";
import { ChannelList, OversightList } from "@/components/chat/channel-list";
import { ChatRoom } from "@/components/chat/chat-room";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
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

  // Wide screens fall back to the org channel; below `lg` the list shows until one is picked.
  const activeId = requestedId ?? (oversee ? null : (lists?.org[0]?._id ?? null));
  const detail = useQuery(api.channels.get, activeId ? { channelId: activeId } : "skip");
  const showConversationOnMobile = requestedId !== null;
  const backHref = oversee ? `/chat/?oversee=${oversee}` : "/chat/";

  return (
    <div className="flex min-h-0 flex-1">
      <div
        className={cn(
          "min-h-0 w-full flex-col border-r border-border lg:flex lg:w-72",
          showConversationOnMobile ? "hidden" : "flex",
        )}
      >
        {oversee ? (
          <OversightList userId={oversee} activeId={activeId} />
        ) : (
          <>
            <PageHeader title={t("title")} />
            {lists ? <ChannelList lists={lists} activeId={activeId} /> : null}
          </>
        )}
      </div>
      <section
        className={cn("min-h-0 min-w-0 flex-1 flex-col lg:flex", showConversationOnMobile ? "flex" : "hidden")}
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
