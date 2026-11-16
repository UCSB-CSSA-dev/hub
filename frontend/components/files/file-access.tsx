"use client";

import { useMutation, useQuery } from "convex/react";
import { HistoryIcon, ShieldIcon, Trash2Icon, UserPlusIcon } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
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
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {g.level === "write" ? t("accessWrite") : t("accessRead")}
                    </span>
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
  const events = useQuery(api.files.history, fileId && open ? { fileId } : "skip");

  const labels: Record<string, string> = {
    created: t("historyAction.created"),
    renamed: t("historyAction.renamed"),
    moved: t("historyAction.moved"),
    trashed: t("historyAction.trashed"),
    restored: t("historyAction.restored"),
    granted: t("historyAction.granted"),
    revoked: t("historyAction.revoked"),
    linked_task: t("historyAction.linked_task"),
  };
  const label = (action: string) => labels[action] ?? action;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t("historyTitle")}</SheetTitle>
          <SheetDescription>{t("historyBody")}</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 pb-4">
          {events === undefined ? (
            <p className="text-sm text-muted-foreground">{t("accessLoading")}</p>
          ) : events === null || events.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("historyEmpty")}</p>
          ) : (
            events.map((e) => (
              <div key={e._id} className="rounded-md border border-border px-3 py-2 text-sm">
                <div className="font-medium">{label(e.action)}</div>
                <div className="text-xs text-muted-foreground">
                  {e.actor ? displayName(e.actor, locale) : "—"} ·{" "}
                  {format.dateTime(e._creationTime, { dateStyle: "medium", timeStyle: "short" })}
                </div>
              </div>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
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
