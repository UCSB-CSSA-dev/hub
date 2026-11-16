"use client";

import { useMutation, useQuery } from "convex/react";
import { ShieldAlertIcon, UserMinusIcon, XIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useViewer } from "@/components/auth/account-state";
import { PersonAvatar } from "@/components/people/person-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { api, type Id } from "@/lib/api";
import { useErrorToast } from "@/lib/errors";
import type { Locale } from "@/lib/locale-store";
import { displayName, localized } from "@/lib/names";
import { cn } from "@/lib/utils";
import { PeopleChecklist, useDepartmentPeople } from "./group-form-dialog";

export function GroupInfoSheet({
  channelId,
  open,
  onOpenChange,
}: {
  channelId: Id<"channels">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("groups");
  const locale = useLocale() as Locale;
  const viewer = useViewer();
  const info = useQuery(api.groups.info, open ? { channelId } : "skip");
  const departments = useQuery(api.departments.listPublic, open ? {} : "skip");
  const removeMember = useMutation(api.groups.removeMember);
  const leave = useMutation(api.groups.leave);
  const end = useMutation(api.groups.end);
  const addDepartment = useMutation(api.groups.addDepartment);
  const removeDepartment = useMutation(api.groups.removeDepartment);
  const showError = useErrorToast();
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirm, setConfirm] = useState<"leave" | "end" | null>(null);

  const manage = info?.viewer.canManage ?? false;
  const otherDepartments = (departments ?? []).filter(
    (d) => d.kind === "regular" && !info?.departments.some((x) => x._id === d._id),
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{info?.name ?? t("groupInfo")}</SheetTitle>
          {info?.purpose ? <SheetDescription>{info.purpose}</SheetDescription> : null}
        </SheetHeader>
        {info ? (
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-5 px-4 pb-6">
              {info.endedAt ? <Badge variant="secondary">{t("ended")}</Badge> : null}
              {info.takenOver ? (
                <div className="flex gap-2 rounded-md border border-primary/40 bg-primary/10 p-3 text-xs text-primary">
                  <ShieldAlertIcon className="size-4 shrink-0" />
                  <span>{t("takenOver")}</span>
                </div>
              ) : null}

              <section className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-medium text-muted-foreground">{t("departments")}</h3>
                  {manage && otherDepartments.length > 0 ? (
                    <Select
                      value=""
                      onValueChange={(id) =>
                        addDepartment({ channelId, departmentId: id as Id<"departments"> }).catch(showError)
                      }
                    >
                      <SelectTrigger size="sm" className="h-7 w-auto text-xs">
                        <SelectValue placeholder={t("addDepartment")} />
                      </SelectTrigger>
                      <SelectContent>
                        {otherDepartments.map((d) => (
                          <SelectItem key={d._id} value={d._id}>
                            {localized(d.nameZh, d.nameEn, locale)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                </div>
                {info.departments.length === 0 ? <p className="text-sm text-muted-foreground">{t("noDepartments")}</p> : null}
                {info.departments.map((d) => (
                  <div key={d._id} className="flex items-start gap-2 rounded-md border border-border p-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        {localized(d.nameZh, d.nameEn, locale)}
                        {d.archived ? <Badge variant="secondary">{t("archived")}</Badge> : null}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {d.leads.length > 0
                          ? t("autoLeads", { names: d.leads.map((p) => displayName(p, locale)).join(locale === "zh" ? "、" : ", ") })
                          : t("noLead")}
                      </div>
                    </div>
                    {d.canRemove ? (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={t("removeDepartment")}
                        onClick={() => removeDepartment({ channelId, departmentId: d._id }).catch(showError)}
                      >
                        <XIcon />
                      </Button>
                    ) : null}
                  </div>
                ))}
              </section>

              {info.takenOver ? (
                <section className="flex flex-col gap-1">
                  <h3 className="text-xs font-medium text-muted-foreground">{t("presidiumManagers")}</h3>
                  <p className="text-sm">
                    {info.presidium.map((p) => displayName(p, locale)).join(locale === "zh" ? "、" : ", ")}
                  </p>
                  {info.systemAdmins.length > 0 ? (
                    <p className="text-sm">
                      <span className="text-muted-foreground">{t("systemAdminManagers")}</span>
                      {info.systemAdmins.map((p) => displayName(p, locale)).join(locale === "zh" ? "、" : ", ")}
                    </p>
                  ) : null}
                </section>
              ) : null}

              <section className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-medium text-muted-foreground">
                    {t("membersCount", { count: info.members.length })}
                  </h3>
                  {manage ? (
                    <Button size="xs" variant="secondary" onClick={() => setAdding(true)}>
                      {t("addMembers")}
                    </Button>
                  ) : null}
                </div>
                {info.members.map((m) => (
                  <div key={m.person._id} className="flex items-center gap-2">
                    <PersonAvatar person={m.person} className="size-7" />
                    <span className={cn("min-w-0 flex-1 truncate text-sm", m.person.status !== "approved" && "text-muted-foreground line-through")}>
                      {displayName(m.person, locale)}
                      {m.person._id === info.proposerId ? (
                        <span className="ml-1.5 text-xs text-muted-foreground">{t("proposer")}</span>
                      ) : null}
                    </span>
                    {m.canRemove ? (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={t("removeMember")}
                        onClick={() => removeMember({ channelId, userId: m.person._id }).catch(showError)}
                      >
                        <UserMinusIcon />
                      </Button>
                    ) : null}
                  </div>
                ))}
              </section>

              <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                {manage ? (
                  <Button size="sm" variant="secondary" onClick={() => setRenaming(true)}>
                    {t("rename")}
                  </Button>
                ) : null}
                {info.viewer.canLeave && !info.endedAt ? (
                  <Button size="sm" variant="secondary" onClick={() => setConfirm("leave")}>
                    {t("leave")}
                  </Button>
                ) : null}
                {manage ? (
                  <Button size="sm" variant="destructive" onClick={() => setConfirm("end")}>
                    {t("end")}
                  </Button>
                ) : null}
              </div>
              {info.viewer.isImplicitLead ? <p className="text-xs text-muted-foreground">{t("implicitLeadHint")}</p> : null}
            </div>
          </ScrollArea>
        ) : null}
      </SheetContent>

      {info ? (
        <>
          <AddMembersDialog
            open={adding}
            onOpenChange={setAdding}
            channelId={channelId}
            existing={info.members.map((m) => m.person._id)}
            isAdmin={viewer.isAdmin}
            ledDepartmentIds={viewer.ledDepartmentIds}
          />
          <RenameDialog
            open={renaming}
            onOpenChange={setRenaming}
            channelId={channelId}
            name={info.name}
            purpose={info.purpose ?? ""}
          />
        </>
      ) : null}
      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm === "end" ? t("endTitle") : t("leaveTitle")}</DialogTitle>
            <DialogDescription>{confirm === "end" ? t("endBody") : t("leaveBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const action = confirm === "end" ? end({ channelId }) : leave({ channelId });
                setConfirm(null);
                action.then(() => onOpenChange(false)).catch(showError);
              }}
            >
              {confirm === "end" ? t("end") : t("leave")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Sheet>
  );
}

function AddMembersDialog({
  open,
  onOpenChange,
  channelId,
  existing,
  isAdmin,
  ledDepartmentIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: Id<"channels">;
  existing: string[];
  isAdmin: boolean;
  ledDepartmentIds: Id<"departments">[];
}) {
  const t = useTranslations("groups");
  const add = useMutation(api.groups.addMembers);
  const showError = useErrorToast();
  const people = useDepartmentPeople(isAdmin ? "all" : ledDepartmentIds);
  const [picked, setPicked] = useState<Id<"users">[]>([]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("addMembers")}</DialogTitle>
          <DialogDescription>{isAdmin ? t("addMembersAdminHint") : t("addMembersLeadHint")}</DialogDescription>
        </DialogHeader>
        <PeopleChecklist
          people={people}
          selected={picked}
          exclude={existing}
          onToggle={(id) => setPicked((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]))}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            disabled={picked.length === 0}
            onClick={() =>
              add({ channelId, userIds: picked })
                .then(() => {
                  setPicked([]);
                  onOpenChange(false);
                })
                .catch(showError)
            }
          >
            {t("addCount", { count: picked.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({
  open,
  onOpenChange,
  channelId,
  name,
  purpose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: Id<"channels">;
  name: string;
  purpose: string;
}) {
  const t = useTranslations("groups");
  const rename = useMutation(api.groups.rename);
  const showError = useErrorToast();
  const [value, setValue] = useState(name);
  const [purposeValue, setPurposeValue] = useState(purpose);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("rename")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rename-name">{t("name")}</Label>
          <Input id="rename-name" value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rename-purpose">{t("purpose")}</Label>
          <Textarea id="rename-purpose" rows={2} value={purposeValue} onChange={(e) => setPurposeValue(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            disabled={!value.trim()}
            onClick={() =>
              rename({ channelId, name: value, purpose: purposeValue })
                .then(() => onOpenChange(false))
                .catch(showError)
            }
          >
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
