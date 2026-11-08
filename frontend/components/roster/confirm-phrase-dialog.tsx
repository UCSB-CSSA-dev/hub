"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useErrorToast } from "@/lib/errors";
import { useEnterSubmit } from "@/lib/keyboard";

export type ConfirmRequest = {
  title: string;
  description?: string;
  phrase: string;
  destructive?: boolean;
  action: () => Promise<unknown>;
};

/** Second check for role changes: the confirm button unlocks only when the phrase is typed exactly. */
export function ConfirmPhraseDialog({
  request,
  onClose,
  onDone,
}: {
  request: ConfirmRequest;
  onClose: () => void;
  onDone?: () => void;
}) {
  const t = useTranslations();
  const showError = useErrorToast();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const matches = value.trim() === request.phrase;

  const confirm = async () => {
    setBusy(true);
    try {
      await request.action();
      onClose();
      onDone?.();
    } catch (error) {
      showError(error);
      setBusy(false);
    }
  };
  const enter = useEnterSubmit(() => {
    if (matches && !busy) void confirm();
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{request.title}</DialogTitle>
          {request.description ? <DialogDescription>{request.description}</DialogDescription> : null}
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (matches && !busy) void confirm();
          }}
        >
          <p className="text-sm text-muted-foreground">{t("confirm.instructions")}</p>
          <p className="rounded-md bg-secondary px-3 py-2 text-sm font-medium text-primary">{request.phrase}</p>
          <Textarea
            autoFocus
            rows={2}
            value={value}
            placeholder={t("confirm.placeholder")}
            aria-label={request.phrase}
            onChange={(e) => setValue(e.target.value)}
            {...enter}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant={request.destructive ? "destructive" : "default"} disabled={!matches || busy}>
              {t("common.confirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
