"use client";

import { useMutation, useQuery } from "convex/react";
import { SparklesIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { useChat } from "@/components/chat/chat-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api } from "@/lib/api";
import { useErrorToast } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { SasaAvatar } from "./sasa-avatar";

export function useAiCredits() {
  return useQuery(api.ai.myCredits);
}

/** Chat types where AI mode can be switched on. */
export function aiChatType(type: string) {
  return type === "org" || type === "department" || type === "group";
}

/** Header badge of a chat with AI mode on: 小飒 idle, and a popover saying the chat is readable by an LLM. */
export function AiModeIndicator() {
  const t = useTranslations("ai");
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("modeOn")}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          className="flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 py-0.5 pr-2 pl-0.5 text-xs font-medium text-primary hover:bg-primary/15"
        >
          <SasaAvatar className="size-6" />
          <span className="hidden sm:inline">{t("modeBadge")}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 text-xs" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="mb-1.5 flex items-center gap-2">
          <SasaAvatar className="size-9" />
          <p className="font-medium text-primary">{t("modeOn")}</p>
        </div>
        <p className="text-muted-foreground">{t("modeReadable")}</p>
        <p className="mt-1.5 text-muted-foreground">{t("modeHowTo")}</p>
      </PopoverContent>
    </Popover>
  );
}

/** Confirms switching AI mode; posts a system message in the chat. */
export function AiModeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("ai");
  const { channel } = useChat();
  const setAiMode = useMutation(api.ai.setAiMode);
  const showError = useErrorToast();
  const [busy, setBusy] = useState(false);
  const enabling = !channel.aiEnabled;
  const confirm = async () => {
    setBusy(true);
    try {
      await setAiMode({ channelId: channel._id, enabled: enabling });
      toast.success(enabling ? t("modeEnabled") : t("modeDisabled"));
      onOpenChange(false);
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SasaAvatar className="size-8" />
            {enabling ? t("enableTitle") : t("disableTitle")}
          </DialogTitle>
          <DialogDescription>{enabling ? t("enableBody") : t("disableBody")}</DialogDescription>
        </DialogHeader>
        {enabling ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>{t("enablePoint1")}</li>
            <li>{t("enablePoint2")}</li>
            <li>{t("enablePoint3")}</li>
          </ul>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button disabled={busy} onClick={() => void confirm()}>
            {enabling ? t("enable") : t("disable")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** This week's credits; the popover explains costs and when they refresh. */
export function CreditsBadge({ className }: { className?: string }) {
  const t = useTranslations("ai");
  const format = useFormatter();
  const credits = useAiCredits();
  const [open, setOpen] = useState(false);
  if (!credits) return null;
  const label = credits.unlimited
    ? t("creditsUnlimited")
    : t("creditsLeft", { balance: credits.balance, allowance: credits.allowance });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          className={cn(
            "flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium tabular-nums",
            !credits.unlimited && credits.balance === 0
              ? "border-destructive/40 bg-destructive/10 text-destructive"
              : "border-border bg-secondary/50 text-muted-foreground",
            className,
          )}
        >
          <SparklesIcon className="size-3" />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 text-xs" onOpenAutoFocus={(e) => e.preventDefault()}>
        <p className="mb-1 font-medium text-primary">{t("creditsTitle")}</p>
        <p className="text-muted-foreground">{t("creditsRules")}</p>
        <p className="mt-1.5 text-muted-foreground">
          {t("creditsReset", {
            when: format.dateTime(credits.nextResetAt, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
          })}
        </p>
      </PopoverContent>
    </Popover>
  );
}
