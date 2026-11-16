"use client";

import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  DiffIcon,
  EyeIcon,
  HistoryIcon,
  RotateCcwIcon,
  ShieldIcon,
  Trash2Icon,
  UserPlusIcon,
} from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { MarkdownView } from "@/components/docs/markdown-view";
import { PersonAvatar } from "@/components/people/person-avatar";
import { PersonPicker } from "@/components/people/person-picker";
import { usePeople } from "@/components/people/use-people";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { api, type Id } from "@/lib/api";
import { useErrorToast } from "@/lib/errors";
import type { Locale } from "@/lib/locale-store";
import { displayName } from "@/lib/names";

type HistoryEvent = NonNullable<FunctionReturnType<typeof api.files.history>>["events"][number];

/** Access list for a file: owner, grants, and implied space / oversight readers. */
export function AccessSheet({
  fileId,
  open,
  onOpenChange,
}: {
  fileId: Id<"files"> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("files");
  const locale = useLocale() as Locale;
  const showError = useErrorToast();
  const data = useQuery(api.files.listAccess, fileId && open ? { fileId } : "skip");
  const revoke = useMutation(api.files.revoke);
  const grant = useMutation(api.files.grant);
  const [adding, setAdding] = useState(false);

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="flex w-full flex-col sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{t("accessTitle")}</SheetTitle>
            <SheetDescription>{t("accessBody")}</SheetDescription>
          </SheetHeader>
          {!data ? (
            <p className="px-4 text-sm text-muted-foreground">{t("accessLoading")}</p>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
              <section className="flex flex-col gap-2">
                <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{t("accessPeople")}</h3>
                {data.owner ? (
                  <div className="flex items-center gap-2 rounded-md px-1 py-1.5 text-sm">
                    <PersonAvatar person={data.owner} className="size-7" />
                    <span className="min-w-0 flex-1 truncate">{displayName(data.owner, locale)}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{t("accessOwner")}</span>
                  </div>
                ) : null}
                {data.grants.map((g) => (
                  <div key={g._id} className="flex items-center gap-2 rounded-md px-1 py-1.5 text-sm">
                    {g.user ? <PersonAvatar person={g.user} className="size-7" /> : <span className="size-7" />}
                    <span className="min-w-0 flex-1 truncate">{g.user ? displayName(g.user, locale) : g.userId}</span>
                    {data.canGrant ? (
                      <Select
                        value={g.level}
                        onValueChange={(level) => {
                          if (level !== "read" && level !== "write") return;
                          if (level === g.level) return;
                          grant({ fileId: fileId!, userId: g.userId, level })
                            .then(() => toast.success(t("accessGranted")))
                            .catch(showError);
                        }}
                      >
                        <SelectTrigger size="sm" className="h-7 w-auto shrink-0 gap-1 border-0 bg-transparent px-1.5 text-xs text-muted-foreground shadow-none hover:bg-muted/60">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent align="end">
                          <SelectItem value="read">{t("accessRead")}</SelectItem>
                          {data.canGrant === "write" || g.level === "write" ? (
                            <SelectItem value="write" disabled={data.canGrant !== "write"}>
                              {t("accessWrite")}
                            </SelectItem>
                          ) : null}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {g.level === "write" ? t("accessWrite") : t("accessRead")}
                      </span>
                    )}
                    {g.removable ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("accessRevoke")}
                        onClick={() =>
                          revoke({ fileId: fileId!, userId: g.userId })
                            .then(() => toast.success(t("accessRevoked")))
                            .catch(showError)
                        }
                      >
                        <Trash2Icon />
                      </Button>
                    ) : null}
                  </div>
                ))}
                {data.canGrant ? (
                  <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => setAdding(true)}>
                    <UserPlusIcon />
                    {t("accessAdd")}
                  </Button>
                ) : null}
              </section>
              <section className="flex flex-col gap-1 text-sm text-muted-foreground">
                <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{t("accessAlso")}</h3>
                {data.implied.spaceMembers ? <p>{t("accessSpaceMembers", { space: locale === "zh" ? data.space.nameZh : data.space.nameEn })}</p> : null}
                <p>{t("accessOversight")}</p>
              </section>
            </div>
          )}
        </SheetContent>
      </Sheet>
      {fileId && data?.canGrant ? (
        <GrantDialog
          open={adding}
          fileId={fileId}
          maxLevel={data.canGrant}
          exclude={new Set([data.owner?._id, ...data.grants.map((g) => g.userId)].filter(Boolean) as string[])}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </>
  );
}

function GrantDialog({
  open,
  fileId,
  maxLevel,
  exclude,
  onClose,
}: {
  open: boolean;
  fileId: Id<"files">;
  maxLevel: "read" | "write";
  exclude: Set<string>;
  onClose: () => void;
}) {
  const t = useTranslations("files");
  const showError = useErrorToast();
  const people = usePeople()?.filter((p) => !exclude.has(p._id));
  const grant = useMutation(api.files.grant);
  const [level, setLevel] = useState<"read" | "write">(maxLevel);
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("accessAdd")}</DialogTitle>
          <DialogDescription>{t("accessAddBody")}</DialogDescription>
        </DialogHeader>
        <Select value={level} onValueChange={(v) => setLevel(v as "read" | "write")}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="read">{t("accessRead")}</SelectItem>
            {maxLevel === "write" ? <SelectItem value="write">{t("accessWrite")}</SelectItem> : null}
          </SelectContent>
        </Select>
        <PersonPicker
          people={people}
          disabled={busy}
          onPick={async (person) => {
            setBusy(true);
            try {
              await grant({ fileId, userId: person._id as Id<"users">, level });
              toast.success(t("accessGranted"));
              onClose();
            } catch (error) {
              showError(error);
            } finally {
              setBusy(false);
            }
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Brief work history for a file. */
export function HistorySheet({
  fileId,
  open,
  onOpenChange,
}: {
  fileId: Id<"files"> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("files");
  const locale = useLocale() as Locale;
  const format = useFormatter();
  const showError = useErrorToast();
  const data = useQuery(api.files.history, fileId && open ? { fileId } : "skip");
  const revert = useMutation(api.files.revertEdit);
  const [preview, setPreview] = useState<HistoryEvent | null>(null);
  const [diffFrom, setDiffFrom] = useState<HistoryEvent | null>(null);
  const [reverting, setReverting] = useState<HistoryEvent | null>(null);
  const [busy, setBusy] = useState(false);

  const labels: Record<string, string> = {
    created: t("historyAction.created"),
    edited: t("historyAction.edited"),
    reverted: t("historyAction.reverted"),
    renamed: t("historyAction.renamed"),
    moved: t("historyAction.moved"),
    trashed: t("historyAction.trashed"),
    restored: t("historyAction.restored"),
    granted: t("historyAction.granted"),
    revoked: t("historyAction.revoked"),
    linked_task: t("historyAction.linked_task"),
  };
  const levelLabel = (level: "read" | "write" | null | undefined) =>
    level === "write" ? t("accessWrite") : level === "read" ? t("accessRead") : "—";
  const label = (e: HistoryEvent) => {
    const actor = e.actor ? displayName(e.actor, locale) : "—";
    const target = e.target ? displayName(e.target, locale) : null;
    if (e.action === "granted" && target) {
      if (e.fromLevel && e.level && e.fromLevel !== e.level) {
        return t("historyAction.grantedChanged", {
          actor,
          target,
          from: levelLabel(e.fromLevel),
          level: levelLabel(e.level),
        });
      }
      return t("historyAction.grantedTo", { actor, target, level: levelLabel(e.level) });
    }
    if (e.action === "revoked" && target) {
      return t("historyAction.revokedFrom", { actor, target, level: levelLabel(e.level) });
    }
    return labels[e.action] ?? e.action;
  };
  const events = data?.events ?? [];
  const editableEvents = events.filter((e) => e.action === "edited" || e.action === "reverted");

  const actorsLabel = (e: HistoryEvent) => {
    const names = (e.actors.length ? e.actors : e.actor ? [e.actor] : [])
      .filter(Boolean)
      .map((p) => displayName(p!, locale));
    return names.length ? names.join("、") : "—";
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="flex w-full flex-col sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{t("historyTitle")}</SheetTitle>
            <SheetDescription>{t("historyBody")}</SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 pb-4">
            {data === undefined ? (
              <p className="text-sm text-muted-foreground">{t("accessLoading")}</p>
            ) : events.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("historyEmpty")}</p>
            ) : (
              events.map((e) => (
                <div key={e._id} className="rounded-md border border-border px-3 py-2 text-sm">
                  <div className="font-medium">{label(e)}</div>
                  <div className="text-xs text-muted-foreground">
                    {e.action === "granted" || e.action === "revoked"
                      ? format.dateTime(e.endedAt ?? e._creationTime, { dateStyle: "medium", timeStyle: "short" })
                      : `${actorsLabel(e)} · ${format.dateTime(e.endedAt ?? e._creationTime, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}`}
                  </div>
                  {e.canPreview || e.canDiff || e.canRevert ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {e.canPreview ? (
                        <Button size="xs" variant="outline" onClick={() => setPreview(e)}>
                          <EyeIcon />
                          {t("historyPreview")}
                        </Button>
                      ) : null}
                      {e.canDiff ? (
                        <Button size="xs" variant="outline" onClick={() => setDiffFrom(e)}>
                          <DiffIcon />
                          {t("historyDiff")}
                        </Button>
                      ) : null}
                      {e.canRevert ? (
                        <Button size="xs" variant="outline" onClick={() => setReverting(e)}>
                          <RotateCcwIcon />
                          {t("historyRevert")}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={preview !== null} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("historyPreviewTitle")}</DialogTitle>
            <DialogDescription>
              {preview ? `${actorsLabel(preview)} · ${format.dateTime(preview.endedAt)}` : null}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-secondary/30 p-3 text-sm">
            {preview?.beforeText?.trim() ? (
              <MarkdownView source={preview.beforeText} breaks />
            ) : (
              <p className="text-muted-foreground">{t("historyEmpty")}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreview(null)}>
              {t("cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <DiffDialog
        open={diffFrom !== null}
        source={diffFrom}
        others={editableEvents}
        onClose={() => setDiffFrom(null)}
        actorsLabel={actorsLabel}
        formatTime={(n) => format.dateTime(n, { dateStyle: "medium", timeStyle: "short" })}
      />

      <Dialog open={reverting !== null} onOpenChange={(o) => !o && !busy && setReverting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("historyRevert")}</DialogTitle>
            <DialogDescription>{t("historyRevertConfirm")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setReverting(null)}>
              {t("cancel")}
            </Button>
            <Button
              disabled={busy || !reverting}
              onClick={() => {
                if (!reverting) return;
                setBusy(true);
                revert({ eventId: reverting._id })
                  .then(() => {
                    toast.success(t("historyReverted"));
                    setReverting(null);
                  })
                  .catch(showError)
                  .finally(() => setBusy(false));
              }}
            >
              {t("historyRevert")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DiffDialog({
  open,
  source,
  others,
  onClose,
  actorsLabel,
  formatTime,
}: {
  open: boolean;
  source: HistoryEvent | null;
  others: HistoryEvent[];
  onClose: () => void;
  actorsLabel: (e: HistoryEvent) => string;
  formatTime: (n: number) => string;
}) {
  const t = useTranslations("files");
  const [otherId, setOtherId] = useState<string>("");
  const other = useMemo(() => others.find((e) => e._id === otherId) ?? null, [others, otherId]);
  const left = source?.afterText ?? source?.beforeText ?? "";
  const right = other?.afterText ?? other?.beforeText ?? "";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setOtherId("");
          onClose();
        }
      }}
    >
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("historyDiffTitle")}</DialogTitle>
          <DialogDescription>{t("historyDiffPick")}</DialogDescription>
        </DialogHeader>
        <Select value={otherId || undefined} onValueChange={setOtherId}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder={t("historyDiffPick")} />
          </SelectTrigger>
          <SelectContent>
            {others
              .filter((e) => e._id !== source?._id)
              .map((e) => (
                <SelectItem key={e._id} value={e._id}>
                  {actorsLabel(e)} · {formatTime(e.endedAt)}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        {!other ? (
          <p className="text-sm text-muted-foreground">{t("historyDiffEmpty")}</p>
        ) : (
          <div className="grid min-h-0 flex-1 gap-3 overflow-hidden sm:grid-cols-2">
            <div className="flex min-h-0 flex-col gap-1">
              <p className="text-xs font-medium text-muted-foreground">{t("historyDiffThis")}</p>
              <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-secondary/30 p-3 text-sm">
                <MarkdownView source={left || " "} breaks />
              </div>
            </div>
            <div className="flex min-h-0 flex-col gap-1">
              <p className="text-xs font-medium text-muted-foreground">{t("historyDiffOther")}</p>
              <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-secondary/30 p-3 text-sm">
                <MarkdownView source={right || " "} breaks />
              </div>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FileAccessActions({ fileId }: { fileId: Id<"files"> }) {
  const t = useTranslations("files");
  const [access, setAccess] = useState(false);
  const [history, setHistory] = useState(false);
  return (
    <>
      <Button size="icon-sm" variant="ghost" aria-label={t("accessTitle")} onClick={() => setAccess(true)}>
        <ShieldIcon />
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label={t("historyTitle")} onClick={() => setHistory(true)}>
        <HistoryIcon />
      </Button>
      <AccessSheet fileId={fileId} open={access} onOpenChange={setAccess} />
      <HistorySheet fileId={fileId} open={history} onOpenChange={setHistory} />
    </>
  );
}
