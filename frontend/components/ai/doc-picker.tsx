"use client";

import { useQuery } from "convex/react";
import { CheckIcon, FileTextIcon, XIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, LIMITS, type Id } from "@/lib/api";
import { cn } from "@/lib/utils";

export type PickedDoc = { _id: Id<"documents">; title: string };

/**
 * Attach documents to a question for 小飒. Shared chats only offer documents everyone in the chat can
 * open; the private 小飒 chat offers any the viewer can open (the server checks both again).
 */
export function SasaDocPicker({
  channelId,
  shared,
  picked,
  onChange,
}: {
  channelId: Id<"channels">;
  shared: boolean;
  picked: PickedDoc[];
  onChange: (docs: PickedDoc[]) => void;
}) {
  const t = useTranslations("ai");
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const choices = useQuery(api.aiDocs.documentChoices, open ? { channelId, search: search.trim() || undefined } : "skip");
  const full = picked.length >= LIMITS.aiDocsPerQuestion;

  const toggle = (doc: PickedDoc) => {
    if (picked.some((p) => p._id === doc._id)) onChange(picked.filter((p) => p._id !== doc._id));
    else if (!full) onChange([...picked, { _id: doc._id, title: doc.title }]);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {picked.map((doc) => (
        <span
          key={doc._id}
          className="inline-flex max-w-48 items-center gap-1 rounded-md border border-primary/40 bg-primary/5 py-0.5 pr-0.5 pl-1.5 text-xs"
        >
          <FileTextIcon className="size-3 shrink-0 text-primary" />
          <span className="truncate">{doc.title}</span>
          <button
            type="button"
            aria-label={t("docRemove")}
            onClick={() => onChange(picked.filter((p) => p._id !== doc._id))}
            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button size="xs" variant="ghost" className="text-primary" disabled={full}>
            <FileTextIcon />
            {t("docAttach")}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" className="w-80 p-2">
          <Input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("docSearch")}
            className="h-8"
          />
          <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">{shared ? t("docSharedHint") : t("docPrivateHint")}</p>
          <div className="mt-1 max-h-64 overflow-y-auto">
            {choices === undefined ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">{t("docLoading")}</p>
            ) : choices.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">{t("docNone")}</p>
            ) : (
              choices.map((doc) => {
                const selected = picked.some((p) => p._id === doc._id);
                return (
                  <button
                    key={doc._id}
                    type="button"
                    disabled={!selected && full}
                    onClick={() => toggle(doc)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50",
                      selected && "bg-primary/10",
                    )}
                  >
                    <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{doc.title}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {t(`docWhere.${doc.where}`)} · {format.relativeTime(doc.updatedAt)}
                      </span>
                    </span>
                    {selected ? <CheckIcon className="size-4 shrink-0 text-primary" /> : null}
                  </button>
                );
              })
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
