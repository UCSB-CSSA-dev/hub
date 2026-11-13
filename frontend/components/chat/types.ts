import type { FunctionReturnType } from "convex/server";
import type { api } from "@/lib/api";
import type { Locale } from "@/lib/locale-store";
import { displayName, localized } from "@/lib/names";

export type ChannelLists = FunctionReturnType<typeof api.channels.listMine>;
export type Channel = ChannelLists["org"][number];
export type ChannelDetail = NonNullable<FunctionReturnType<typeof api.channels.get>>;
export type Message = FunctionReturnType<typeof api.messages.list>["page"][number];
export type Person = Message["people"][number];

type Labels = {
  general: string;
  orgAnnouncements: string;
  announcementOf: (department: string) => string;
  sasa: string;
  sasaOf: (owner: string) => string;
};

/**
 * Display name for any channel. DMs seen through oversight show both people ("A ↔ B"),
 * because neither of them is the viewer.
 */
export function channelName(
  channel: Pick<Channel, "type" | "nameZh" | "nameEn" | "name" | "otherUser" | "dmUsers">,
  locale: Locale,
  labels: Labels,
  viewerId?: string,
): string {
  switch (channel.type) {
    case "org":
      return labels.general;
    case "announcement":
      return channel.nameZh || channel.nameEn
        ? labels.announcementOf(localized(channel.nameZh, channel.nameEn, locale))
        : labels.orgAnnouncements;
    case "department":
      return localized(channel.nameZh, channel.nameEn, locale);
    case "group":
      return channel.name ?? "";
    case "dm": {
      const users = channel.dmUsers ?? [];
      if (viewerId && users.length === 2 && !users.some((u) => u._id === viewerId)) {
        return users.map((u) => displayName(u, locale)).join(" ↔ ");
      }
      return displayName(channel.otherUser, locale);
    }
    case "assistant":
      return channel.otherUser && channel.otherUser._id !== viewerId
        ? labels.sasaOf(displayName(channel.otherUser, locale))
        : labels.sasa;
  }
}

export function personById(people: Person[], id: string | null | undefined) {
  return id ? people.find((p) => p._id === id) : undefined;
}
