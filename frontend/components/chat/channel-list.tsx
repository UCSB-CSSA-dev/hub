"use client";

import { useMutation, useQuery } from "convex/react";
import {
  ArrowLeftIcon,
  BellIcon,
  BellOffIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  EyeIcon,
  HashIcon,
  MegaphoneIcon,
  MoreHorizontalIcon,
  PinIcon,
  PlusIcon,
  SparklesIcon,
  Trash2Icon,
  UsersRoundIcon,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useFormatter, useLocale, useNow, useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";
import logoMark from "@/assets/brand/logo-mark.webp";
import { useAiCredits } from "@/components/ai/ai-chat";
import { SasaAvatar } from "@/components/ai/sasa-avatar";
import { useViewer } from "@/components/auth/account-state";
import { GroupFormDialog } from "@/components/groups/group-form-dialog";
import { ProposalsDialog } from "@/components/groups/proposals-dialog";
import { PersonAvatar } from "@/components/people/person-avatar";
import { PersonPicker } from "@/components/people/person-picker";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, LIMITS, type Id } from "@/lib/api";
import { useErrorToast } from "@/lib/errors";
import type { Locale } from "@/lib/locale-store";
import { displayName } from "@/lib/names";
import { cn } from "@/lib/utils";
import { useHiddenChannels } from "./hidden-channels";
import { usePlainPreview } from "./markdown";
import { NewDmDialog } from "./new-dm-dialog";
import type { Channel, ChannelLists } from "./types";
import { useChannelName } from "./use-channel-name";

type MuteDuration = "30m" | "1h" | "1d";

export function ChannelList({
  lists,
  activeId,
  filter = "",
}: {
  lists: ChannelLists;
  activeId: string | null;
  filter?: string;
}) {
  const t = useTranslations("chat");
  const viewer = useViewer();
  const params = useSearchParams();
  const channelNameOf = useChannelName();
  const { hidden, hide } = useHiddenChannels();
  const [proposalsOpen, setProposalsOpen] = useState(params.get("proposals") === "1");
  const canOversee = viewer.isAdmin || viewer.ledDepartmentIds.length > 0;
  const href = (id: string) => `/chat/?c=${id}`;
  const needle = filter.trim().toLowerCase();
  const matches = (c: Channel) => {
    if (hidden.has(c._id) && (c.type === "group" || c.type === "dm")) return false;
    if (!needle) return true;
    const name = channelNameOf(c).toLowerCase();
    if (name.includes(needle)) return true;
    const people = [
      c.otherUser,
      ...(c.dmUsers ?? []),
    ].filter(Boolean) as NonNullable<Channel["otherUser"]>[];
    return people.some((p) =>
      [p.nameZh, p.nameEn, p.name, p.email].some((v) => v?.toLowerCase().includes(needle)),
    );
  };
  const org = lists.org.filter(matches);
  const departments = lists.departments.filter(matches);
  const groups = lists.groups.filter(matches);
  const dms = lists.dms.filter(matches);
  const assistant = lists.assistant && matches(lists.assistant) ? lists.assistant : needle ? null : lists.assistant;
  const empty = needle && !assistant && org.length + departments.length + groups.length + dms.length === 0;
  const item = (c: Channel) => (
    <ChannelItem key={c._id} channel={c} active={c._id === activeId} href={href(c._id)} onHide={hide} />
  );

  return (
    <ScrollArea className="min-h-0 w-full min-w-0 flex-1">
      <div className="flex w-full min-w-0 flex-col gap-4 p-2">
        {empty ? <p className="px-2.5 py-6 text-center text-sm text-muted-foreground">{t("searchListEmpty")}</p> : null}
        <SasaEntry channel={assistant} active={assistant?._id === activeId} />
        {org.length > 0 || !needle ? <Section title={t("sectionGeneral")}>{org.map(item)}</Section> : null}
        {departments.length > 0 ? (
          <Section title={t("sectionDepartments")}>{departments.map(item)}</Section>
        ) : null}
        <Section
          title={t("sectionGroups")}
          action={
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="relative size-7 text-muted-foreground"
                    aria-label={t("groupProposals")}
                    onClick={() => setProposalsOpen(true)}
                  >
                    <ClipboardListIcon className="size-4" />
                    {viewer.pendingGroupCount > 0 ? (
                      <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary" />
                    ) : null}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("groupProposals")}</TooltipContent>
              </Tooltip>
              <GroupFormDialog>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="size-7 text-foreground"
                  aria-label={t("newGroup")}
                  title={t("newGroup")}
                >
                  <PlusIcon className="size-4" strokeWidth={2.5} />
                </Button>
              </GroupFormDialog>
            </>
          }
        >
          {!needle && viewer.pendingGroupCount > 0 ? (
            <button
              type="button"
              onClick={() => setProposalsOpen(true)}
              className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-primary hover:bg-accent"
            >
              <ClipboardListIcon className="size-3.5" />
              {t("pendingGroups", { count: viewer.pendingGroupCount })}
            </button>
          ) : null}
          {groups.length === 0 ? (
            <p className="px-2.5 py-1 text-xs text-muted-foreground">{t("noGroups")}</p>
          ) : (
            groups.map(item)
          )}
        </Section>
        <Section
          title={t("sectionDms")}
          action={
            <NewDmDialog>
              <Button
                size="icon-sm"
                variant="ghost"
                className="size-7 text-foreground"
                aria-label={t("newDm")}
                title={t("newDm")}
              >
                <PlusIcon className="size-4" strokeWidth={2.5} />
              </Button>
            </NewDmDialog>
          }
        >
          {dms.length === 0 ? (
            <p className="px-2.5 py-1 text-xs text-muted-foreground">{t("noDms")}</p>
          ) : (
            dms.map(item)
          )}
        </Section>
        {!needle && canOversee ? <OversightSection /> : null}
      </div>
      <ProposalsDialog open={proposalsOpen} onOpenChange={setProposalsOpen} />
    </ScrollArea>
  );
}

/** The viewer's private 小飒 chat, pinned on top; created on first open. */
function SasaEntry({ channel, active }: { channel: Channel | null; active: boolean }) {
  const t = useTranslations("chat");
  const credits = useAiCredits();
  const router = useRouter();
  const ensure = useMutation(api.ai.ensureAssistantChannel);
  const showError = useErrorToast();
  if (channel) {
    return <ChannelItem channel={channel} active={active} href={`/chat/?c=${channel._id}`} pinned />;
  }
  if (!credits?.configured) return null;
  return (
    <button
      type="button"
      onClick={() => ensure().then((id) => router.push(`/chat/?c=${id}`), showError)}
      className="flex items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-accent/60"
    >
      <SasaAvatar className="size-11 rounded-md" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1 text-sm font-medium">
          {t("sasaChat")}
          <PinIcon className="size-3 text-muted-foreground" />
        </span>
        <span className="truncate text-xs text-muted-foreground">{t("sasaIntro")}</span>
      </span>
    </button>
  );
}

/** Collapsed entry for admins and 部长: pick a person to read their chats. */
function OversightSection() {
  const t = useTranslations("chat");
  const [open, setOpen] = useState(false);
  return (
    <Section title={t("sectionOversight")}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <EyeIcon className="size-4 shrink-0 text-primary/80" />
        <span className="flex-1">{t("oversightPick")}</span>
        <ChevronRightIcon className="size-4" />
      </button>
      <OversightPicker open={open} onOpenChange={setOpen} />
    </Section>
  );
}

function OversightPicker({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("chat");
  const router = useRouter();
  const people = useQuery(api.channels.oversightPeople, open ? {} : "skip");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("oversightPickTitle")}</DialogTitle>
          <DialogDescription>{t("oversightPickHint")}</DialogDescription>
        </DialogHeader>
        {open ? (
          <PersonPicker
            people={people}
            onPick={(person) => {
              onOpenChange(false);
              router.push(`/chat/?oversee=${person._id}`);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Left column while overseeing one person: their chats the viewer can only read through oversight. */
export function OversightList({ userId, activeId }: { userId: Id<"users">; activeId: string | null }) {
  const t = useTranslations("chat");
  const locale = useLocale() as Locale;
  const channels = useQuery(api.channels.oversightChannels, { userId });
  const person = useQuery(api.channels.oversightPeople)?.find((p) => p._id === userId);
  const href = (id: string) => `/chat/?oversee=${userId}&c=${id}`;
  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Button asChild size="icon-sm" variant="ghost" aria-label={t("exitOversight")}>
          <Link href="/chat/">
            <ArrowLeftIcon />
          </Link>
        </Button>
        <EyeIcon className="size-4 text-primary" />
        <span className="min-w-0 flex-1 truncate text-sm">
          {t("overseeing", { name: person ? displayName(person, locale) : "…" })}
        </span>
      </div>
      <p className="border-b border-border bg-primary/5 px-3 py-2 text-xs text-muted-foreground">{t("oversightLogged")}</p>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5 p-2">
          {channels === null ? (
            <p className="px-2.5 py-1 text-xs text-muted-foreground">{t("oversightForbidden")}</p>
          ) : channels && channels.length === 0 ? (
            <p className="px-2.5 py-1 text-xs text-muted-foreground">{t("oversightNone")}</p>
          ) : null}
          {(channels ?? []).map((c) => (
            <ChannelItem key={c._id} channel={c} active={c._id === activeId} href={href(c._id)} />
          ))}
        </div>
      </ScrollArea>
    </>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-0.5">
      {/* Keep actions beside the title — the list is often full-width, so justify-between
          would park the + buttons on the far right of the screen. */}
      <div className="flex min-h-7 items-center gap-0.5 px-2.5">
        <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>
        {action ? <div className="flex shrink-0 items-center">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

function ChannelItem({
  channel,
  active,
  href,
  pinned,
  onHide,
}: {
  channel: Channel;
  active: boolean;
  href: string;
  pinned?: boolean;
  onHide?: (channelId: Id<"channels">) => void;
}) {
  const t = useTranslations("chat");
  const name = useChannelName()(channel);
  const previewText = usePreviewText();
  const time = useListTime();
  const setMuted = useMutation(api.channels.setMuted);
  const showError = useErrorToast();
  const unread = channel.unread;
  const announcements = channel.unseenAnnouncements;
  const inactive = channel.ended || channel.archived;
  const cap = (count: number) => (count > LIMITS.unreadCountCap ? `${LIMITS.unreadCountCap}+` : count);
  const preview = channel.preview ? previewText(channel, channel.preview) : null;
  const timedMute = channel.type === "org" || channel.type === "department";
  const canHide = (channel.type === "group" || channel.type === "dm") && onHide;
  const showMenu = !pinned && channel.type !== "assistant";

  const mute = (duration?: MuteDuration) =>
    setMuted({ channelId: channel._id, muted: true, duration }).catch(showError);
  const unmute = () => setMuted({ channelId: channel._id, muted: false }).catch(showError);

  return (
    <div
      className={cn(
        "group/row relative w-full min-w-0 rounded-md transition-colors",
        active ? "bg-accent" : "hover:bg-accent/60",
        inactive && "opacity-60",
      )}
    >
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        className={cn("flex w-full min-w-0 items-center gap-2.5 px-2 py-2", showMenu && "pr-10")}
      >
        <span className="relative shrink-0">
          <ChannelFaces channel={channel} />
          {unread > 0 && !active ? (
            channel.muted ? (
              <span
                className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-destructive ring-2 ring-background"
                aria-label={t("unreadMuted")}
              />
            ) : (
              <span
                className="absolute -top-1.5 -right-1.5 min-w-4.5 rounded-full bg-destructive px-1 text-center text-[10px] leading-4.5 font-semibold text-white ring-2 ring-background"
                aria-label={t("list.unread", { count: unread })}
              >
                {cap(unread)}
              </span>
            )
          ) : null}
          {announcements > 0 ? (
            <span
              className="absolute -right-1 -bottom-1 flex size-4.5 items-center justify-center rounded-full bg-warning text-primary-foreground ring-2 ring-background"
              aria-label={t("unseenAnnouncements", { count: announcements })}
            >
              <MegaphoneIcon className="size-2.5" />
            </span>
          ) : null}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline gap-2">
            <span className="flex min-w-0 flex-1 items-center gap-1">
              <span className="truncate text-sm font-medium text-foreground">{name}</span>
              {pinned ? <PinIcon className="size-3 shrink-0 text-muted-foreground" aria-label={t("list.pinned")} /> : null}
              {channel.aiEnabled ? (
                <SparklesIcon className="size-3 shrink-0 text-primary" aria-label={t("list.aiOn")} />
              ) : null}
            </span>
            {inactive ? (
              <span className="shrink-0 text-[10px] text-muted-foreground">
                {channel.ended ? t("endedTag") : t("archivedTag")}
              </span>
            ) : channel.preview ? (
              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{time(channel.preview.at)}</span>
            ) : null}
          </span>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">
              {announcements > 0 ? (
                <span className="text-warning">{t("list.announcementTag", { count: cap(announcements) })} </span>
              ) : channel.muted && unread > 0 ? (
                <span>{t("list.mutedCount", { count: cap(unread) })} </span>
              ) : null}
              {preview ?? "\u00a0"}
            </span>
            {channel.muted ? <BellOffIcon className="size-3 shrink-0" aria-label={t("list.muted")} /> : null}
          </span>
        </span>
      </Link>
      {showMenu ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon-sm"
              variant="secondary"
              className="absolute top-1/2 right-1.5 z-10 size-7 -translate-y-1/2 shadow-sm"
              aria-label={t("more")}
              onClick={(e) => e.preventDefault()}
            >
              <MoreHorizontalIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {channel.muted ? (
              <DropdownMenuItem onSelect={() => void unmute()}>
                <BellIcon />
                {t("unmute")}
              </DropdownMenuItem>
            ) : timedMute ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <BellOffIcon />
                  {t("muteFor")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem onSelect={() => void mute("30m")}>{t("mute30m")}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void mute("1h")}>{t("mute1h")}</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void mute("1d")}>{t("mute1d")}</DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : (
              <DropdownMenuItem onSelect={() => void mute()}>
                <BellOffIcon />
                {t("mute")}
              </DropdownMenuItem>
            )}
            {canHide ? (
              <DropdownMenuItem variant="destructive" onSelect={() => onHide(channel._id)}>
                <Trash2Icon />
                {t("hideOnDevice")}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

type Preview = NonNullable<Channel["preview"]>;

/** "Alice: 今晚开会" — the sender is left out of DMs unless it's the viewer. */
function usePreviewText() {
  const t = useTranslations("chat.list");
  const locale = useLocale() as Locale;
  const viewer = useViewer();
  const plain = usePlainPreview();
  return (channel: Channel, preview: Preview) => {
    const mine = preview.authorId === viewer._id;
    const author = mine ? t("you") : displayName(preview.people.find((p) => p._id === preview.authorId), locale);
    if (preview.state === "recalled") return t("recalled", { name: author });
    if (preview.state === "removed") return t("removed");
    const content =
      preview.kind === "forward"
        ? t("forward")
        : preview.kind === "task"
          ? t("task")
          : preview.kind === "doc"
            ? t("doc")
            : preview.kind === "ai" && !preview.body
              ? t("ai")
              : plain(preview.body, preview.people, 80) || t("attachment");
    const text = preview.announcement ? `${t("announcement")} ${content}` : content;
    if ((channel.type === "dm" || channel.type === "assistant") && !mine) return text;
    return t("withSender", { name: author, text });
  };
}

/** WeChat-style stamp: time today, "昨天", a weekday this week, then a date. */
function useListTime() {
  const t = useTranslations("chat.list");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  return (at: number) => {
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const day = 24 * 60 * 60 * 1000;
    const date = new Date(at);
    if (at >= startOfToday.getTime()) return format.dateTime(date, { hour: "2-digit", minute: "2-digit", hour12: false });
    if (at >= startOfToday.getTime() - day) return t("yesterday");
    if (at >= startOfToday.getTime() - 6 * day) return format.dateTime(date, { weekday: "short" });
    if (date.getFullYear() === now.getFullYear()) return format.dateTime(date, { month: "numeric", day: "numeric" });
    return format.dateTime(date, { year: "numeric", month: "numeric", day: "numeric" });
  };
}

const FACE_GRID: Record<number, string> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-2", 4: "grid-cols-2" };

/** A DM shows the other person; team chats a grid of up to 9 members; the org chat the CSSA mark. */
function ChannelFaces({ channel }: { channel: Channel }) {
  const box = "size-11 overflow-hidden rounded-md bg-secondary";
  if (channel.type === "assistant") return <SasaAvatar className={cn(box, "bg-white")} />;
  if (channel.type === "dm") {
    return channel.otherUser ? (
      <PersonAvatar person={channel.otherUser} className={cn(box, "after:rounded-md [&>*]:rounded-md")} />
    ) : (
      <span className={cn(box, "flex items-center justify-center text-muted-foreground")}>
        <UsersRoundIcon className="size-5" />
      </span>
    );
  }
  if (channel.type === "org") {
    return (
      <span className={cn(box, "flex items-center justify-center bg-primary/10 p-1")}>
        <Image src={logoMark} alt="" className="h-auto w-full" />
      </span>
    );
  }
  const faces = channel.faces ?? [];
  if (faces.length === 0) {
    return (
      <span className={cn(box, "flex items-center justify-center text-muted-foreground")}>
        {channel.type === "group" ? <UsersRoundIcon className="size-5" /> : <HashIcon className="size-5" />}
      </span>
    );
  }
  return (
    <span
      className={cn(
        box,
        "grid content-center gap-px bg-muted p-px",
        FACE_GRID[faces.length] ?? "grid-cols-3",
        faces.length === 3 && "[&>*:first-child]:col-span-2 [&>*:first-child]:mx-auto [&>*:first-child]:w-1/2",
      )}
    >
      {faces.map((face) => (
        <PersonAvatar
          key={face._id}
          person={face}
          className="aspect-square size-auto w-full rounded-[2px] after:hidden [&>*]:rounded-[2px] [&>span]:text-[7px]"
        />
      ))}
    </span>
  );
}
