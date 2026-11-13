"use client";

import { useMutation, useQuery } from "convex/react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ChatRoom } from "@/components/chat/chat-room";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { api, type Id } from "@/lib/api";
import { useErrorToast } from "@/lib/errors";
import { useAiCredits } from "./ai-chat";
import { SasaAvatar } from "./sasa-avatar";

/** 小飒 floating in the corner of every page except chat, opening the private chat in a side panel. */
export function SasaFab() {
  const t = useTranslations("ai");
  const pathname = usePathname();
  const credits = useAiCredits();
  const ensure = useMutation(api.ai.ensureAssistantChannel);
  const showError = useErrorToast();
  const [channelId, setChannelId] = useState<Id<"channels"> | null>(null);
  // Remembering where the panel opened closes it on navigation, e.g. after following a task link.
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const open = openedOn === pathname;
  const setOpen = (next: boolean) => setOpenedOn(next ? pathname : null);
  const detail = useQuery(api.channels.get, open && channelId ? { channelId } : "skip");

  if (!credits?.configured || pathname.startsWith("/chat")) return null;

  const openPanel = async () => {
    try {
      setChannelId(channelId ?? (await ensure()));
      setOpen(true);
    } catch (error) {
      showError(error);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void openPanel()}
        aria-label={t("open")}
        className="fixed right-4 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-40 rounded-full shadow-lg ring-2 ring-primary/40 transition-transform hover:scale-105 md:right-6 md:bottom-6"
      >
        <SasaAvatar state={credits.inFlight ? "think" : "idle"} className="size-14" />
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" showCloseButton={false} aria-describedby={undefined} className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md">
          <SheetTitle className="sr-only">{t("chatTitle")}</SheetTitle>
          {detail ? (
            <ChatRoom channel={detail} initialFocus={null} initialApp={null} onClose={() => setOpen(false)} />
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
