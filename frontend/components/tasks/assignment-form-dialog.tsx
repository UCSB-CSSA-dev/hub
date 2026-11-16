"use client";

import { useQuery } from "convex/react";
import { useTranslations } from "next-intl";
import { TaskForm } from "@/components/tasks/task-form";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type Id } from "@/lib/api";

export type AssignmentFormDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId?: Id<"channels">;
  suggestionId?: Id<"aiSuggestions">;
  assignmentId?: Id<"assignments">;
  eventId?: Id<"assignments">;
  kind?: "task" | "event";
};

/** In-chat (or elsewhere) popup with the same TaskForm as /assignments/new. */
export function AssignmentFormDialog({
  open,
  onOpenChange,
  channelId,
  suggestionId,
  assignmentId,
  eventId,
  kind = "task",
}: AssignmentFormDialogProps) {
  const t = useTranslations("tasks");
  const creatable = useQuery(api.assignments.creatableChannels, open ? {} : "skip");
  const existing = useQuery(api.assignments.get, open && assignmentId ? { assignmentId } : "skip");
  const suggestion = useQuery(api.ai.getSuggestion, open && suggestionId ? { suggestionId } : "skip");

  const loading =
    open &&
    (creatable === undefined ||
      (assignmentId !== undefined && existing === undefined) ||
      (suggestionId !== undefined && suggestion === undefined));

  // A card already used, or meant for another task, opens the plain form.
  const usable =
    suggestion &&
    suggestion.status === "pending" &&
    suggestion.canAct &&
    (assignmentId
      ? suggestion.action === "edit" && suggestion.assignmentId === assignmentId
      : suggestion.action !== "edit")
      ? suggestion
      : null;

  const title =
    assignmentId || usable?.action === "edit"
      ? t("editTitle")
      : (usable?.action === "create_event" || kind === "event")
        ? t("newEvent")
        : t("newTask");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(90vh,44rem)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b border-border px-4 py-3">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {loading ? (
            <div className="flex flex-col gap-3 p-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-16" />
              ))}
            </div>
          ) : creatable ? (
            <TaskForm
              key={`${assignmentId ?? "new"}:${usable?._id ?? ""}:${open ? "1" : "0"}`}
              creatable={creatable}
              existing={existing ?? null}
              suggestion={usable}
              initialChannel={channelId}
              initialEvent={eventId}
              initialKind={usable?.action === "create_event" ? "event" : kind}
              embedded
              onDone={() => onOpenChange(false)}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
