"use client";

import { useQuery } from "convex/react";
import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense } from "react";
import { PageHeader } from "@/components/layout/app-shell";
import { TaskForm } from "@/components/tasks/task-form";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, type Id } from "@/lib/api";

export default function NewAssignmentPage() {
  return (
    <Suspense>
      <NewAssignment />
    </Suspense>
  );
}

function NewAssignment() {
  const t = useTranslations("tasks");
  const router = useRouter();
  const params = useSearchParams();
  const editId = params.get("a") as Id<"assignments"> | null;
  const existing = useQuery(api.assignments.get, editId ? { assignmentId: editId } : "skip");
  const creatable = useQuery(api.assignments.creatableChannels);
  const suggestionId = params.get("s") as Id<"aiSuggestions"> | null;
  const suggestion = useQuery(api.ai.getSuggestion, suggestionId ? { suggestionId } : "skip");
  if (creatable === undefined || (editId && existing === undefined) || (suggestionId && suggestion === undefined)) {
    return (
      <>
        <PageHeader title="" />
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 p-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      </>
    );
  }
  // A card already used, or meant for another task, opens the plain form.
  const usable =
    suggestion &&
    suggestion.status === "pending" &&
    suggestion.canAct &&
    (editId ? suggestion.action === "edit" && suggestion.assignmentId === editId : suggestion.action !== "edit")
      ? suggestion
      : null;
  const a = existing?.assignment;
  const kind = params.get("kind") === "event" ? "event" : "task";
  const title = a ? t("editTitle") : usable?.action === "create_event" || kind === "event" ? t("newEvent") : t("newTask");

  return (
    <>
      <PageHeader title={title}>
        <Button asChild size="sm" variant="ghost">
          <Link href={a ? `/assignments/view/?a=${a._id}` : "/assignments/"}>
            <ArrowLeftIcon />
            {t("back")}
          </Link>
        </Button>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <TaskForm
          key={`${editId ?? "new"}:${usable?._id ?? ""}`}
          creatable={creatable}
          existing={existing ?? null}
          suggestion={usable}
          initialChannel={(params.get("c") as Id<"channels"> | null) ?? undefined}
          initialEvent={(params.get("event") as Id<"assignments"> | null) ?? undefined}
          initialKind={kind}
          onDone={(id) => router.push(`/assignments/view/?a=${id}`)}
        />
      </div>
    </>
  );
}
