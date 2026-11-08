"use client";

import { Trash2Icon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { FileTypeIcon } from "@/components/files/file-icon";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  clearCache,
  CLEAR_AGE_DAYS,
  listCached,
  onCacheChange,
  removeCached,
  removeOlderThan,
  type CachedFile,
} from "@/lib/file-cache";
import { formatBytes } from "@/lib/format";

function useCachedFiles() {
  const [files, setFiles] = useState<CachedFile[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      void listCached()
        .then((list) => live && setFiles(list))
        .catch(() => live && setFiles([]));
    load();
    const off = onCacheChange(load);
    return () => {
      live = false;
      off();
    };
  }, []);
  return files;
}

/** Files opened in the app and kept on this device, with ways to free the space. */
export function DeviceFilesCard() {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const format = useFormatter();
  const files = useCachedFiles();
  const [days, setDays] = useState<string>(String(CLEAR_AGE_DAYS[0]));
  const [confirmAll, setConfirmAll] = useState(false);
  const total = files?.reduce((sum, f) => sum + f.size, 0) ?? 0;

  const clearOlder = async () => {
    const count = await removeOlderThan(Number(days));
    toast.success(t("deviceFilesRemoved", { count }));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("deviceFilesTitle")}</CardTitle>
        <CardDescription>{t("deviceFilesBody")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm">
          {files === null ? "…" : t("deviceFilesSummary", { count: files.length, size: formatBytes(total) })}
        </p>
        {files && files.length > 0 ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">{t("deviceFilesOlderThan")}</span>
              <Select value={days} onValueChange={setDays}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CLEAR_AGE_DAYS.map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {t("deviceFilesDays", { days: d })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={() => void clearOlder()}>
                {t("deviceFilesDeleteOlder")}
              </Button>
              <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirmAll(true)}>
                {t("deviceFilesDeleteAll")}
              </Button>
            </div>
            <div className="max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border">
              {files.map((f) => (
                <div key={f.key} className="flex items-center gap-3 px-3 py-2">
                  <FileTypeIcon contentType={f.contentType} name={f.name} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{f.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatBytes(f.size)} · {t("deviceFilesKeptOn", { date: format.dateTime(f.cachedAt, { dateStyle: "medium" }) })}
                    </div>
                  </div>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("deviceFilesDelete", { name: f.name })}
                    onClick={() => void removeCached([f.key])}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </CardContent>
      <Dialog open={confirmAll} onOpenChange={setConfirmAll}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deviceFilesDeleteAll")}</DialogTitle>
            <DialogDescription>{t("deviceFilesDeleteAllBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAll(false)}>
              {tc("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmAll(false);
                void clearCache().then(() => toast.success(t("deviceFilesRemoved", { count: files?.length ?? 0 })));
              }}
            >
              {t("deviceFilesDeleteAll")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
