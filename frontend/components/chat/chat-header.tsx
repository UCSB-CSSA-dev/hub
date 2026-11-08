"use client";

import { useMutation, useQuery } from "convex/react";
import {
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  BellIcon,
  BellOffIcon,
  ClockIcon,
  EyeIcon,
  FilePenLineIcon,
  FilesIcon,
  InfoIcon,
  ListChecksIcon,
  MoreVerticalIcon,
  PlusIcon,
  SearchIcon,
} from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useViewer } from "@/components/auth/account-state";
import { chatHasDocs } from "@/components/docs/chat-documents";
import { PageHeader } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { useErrorToast } from "@/lib/errors";
import { useHiddenMessages } from "@/lib/hidden-messages";
import type { Locale } from "@/lib/locale-store";
import { displayName, localized } from "@/lib/names";
import { useChat } from "./chat-context";
import { ChatMembersButton } from "./chat-members";

export function ChatHeader({
  title,
  backHref,
  onSearch,
  onRetention,
  onGroupInfo,
  onEndedApps,
  onDocuments,
  onNewDocument,
  extra,
}: {
  title: string;
  backHref: string;
  onSearch: () => void;
  onRetention: () => void;
  onGroupInfo: () => void;
  onEndedApps: () => void;
  onDocuments: () => void;
  onNewDocument: () => void;
  extra?: ReactNode;
}) {
  const t = useTranslations("chat");
  const viewer = useViewer();
  const { channel, startSelecting } = useChat();
  const setMuted = useMutation(api.channels.setMuted);
  const showError = useErrorToast();
  const { hidden, restore } = useHiddenMessages(viewer._id);
  const isMember = channel.access.via === "member";
  const canStartDoc = isMember && channel.access.canPost && channel.access.canInteract;

  return (
    <PageHeader
      title={
        <span className="flex items-center gap-2">
          <Button asChild size="icon-sm" variant="ghost" className="lg:hidden" aria-label={t("title")}>
            <Link href={backHref}>
              <ArrowLeftIcon />
            </Link>
          </Button>
          <span className="truncate">{title}</span>
          {channel.muted ? <BellOffIcon className="size-3.5 shrink-0 text-muted-foreground" /> : null}
        </span>
      }
    >
      {extra}
      <ChatMembersButton />
      <MonitoredIcon />
      <Button size="icon-sm" variant="ghost" aria-label={t("searchTitle")} onClick={onSearch}>
        <SearchIcon />
      </Button>
      {chatHasDocs(channel.type) ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={t("documents")}>
              <FilePenLineIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {canStartDoc ? (
              <DropdownMenuItem onSelect={onNewDocument}>
                <PlusIcon />
                {t("newDocument")}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onSelect={onDocuments}>
              <FilesIcon />
              {t("allDocuments")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label={t("more")}>
            <MoreVerticalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {channel.type === "group" ? (
            <DropdownMenuItem onSelect={onGroupInfo}>
              <InfoIcon />
              {t("groupInfo")}
            </DropdownMenuItem>
          ) : null}
          {isMember ? (
            <DropdownMenuItem
              onSelect={() => setMuted({ channelId: channel._id, muted: !channel.muted }).catch(showError)}
            >
              {channel.muted ? <BellIcon /> : <BellOffIcon />}
              {channel.muted ? t("unmute") : t("mute")}
            </DropdownMenuItem>
          ) : null}
          {channel.access.canSetRetention ? (
            <DropdownMenuItem onSelect={onRetention}>
              <ClockIcon />
              {t("retentionMenu", { days: channel.retentionDays })}
            </DropdownMenuItem>
          ) : null}
          {channel.type !== "dm" ? (
            <DropdownMenuItem onSelect={onEndedApps}>
              <ListChecksIcon />
              {t("endedApps")}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => startSelecting()}>
            <ListChecksIcon />
            {t("select")}
          </DropdownMenuItem>
          {hidden.size > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => {
                  restore([...hidden]);
                  toast.success(t("restored"));
                }}
              >
                <ArchiveRestoreIcon />
                {t("restoreLocal")}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </PageHeader>
  );
}

/** Top-right eye icon: who can view this chat besides its participants. */
function MonitoredIcon() {
  const t = useTranslations("chat");
  const locale = useLocale() as Locale;
  const { channel } = useChat();
  const watchers = useQuery(api.channels.watchers, { channelId: channel._id });
  const [open, setOpen] = useState(false);
  const separator = locale === "zh" ? "、" : ", ";

  let text = t("monitoredLoading");
  if (watchers?.visibleToAll) text = t("visibleToAll");
  else if (watchers) {
    const parts = [t("monitoredPresidium")];
    for (const lead of watchers.leads) {
      parts.push(
        t("monitoredLeads", {
          department: localized(lead.nameZh, lead.nameEn, locale),
          names: lead.people.map((p) => displayName(p, locale)).join(separator),
        }),
      );
    }
    text = t("monitoredBy", { list: parts.join(locale === "zh" ? "；" : "; ") });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("monitored")}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          className="rounded-md p-1.5 text-primary/80 hover:bg-accent hover:text-primary"
        >
          <EyeIcon className="size-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 text-xs" onOpenAutoFocus={(e) => e.preventDefault()}>
        <p className="mb-1 font-medium text-primary">{t("monitored")}</p>
        <p className="text-muted-foreground">{text}</p>
      </PopoverContent>
    </Popover>
  );
}
