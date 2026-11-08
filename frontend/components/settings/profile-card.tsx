"use client";

import { useMutation } from "convex/react";
import { EyeIcon, ImageUpIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useViewer } from "@/components/auth/account-state";
import { PersonAvatar } from "@/components/people/person-avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, LIMITS, type Id } from "@/lib/api";
import { useErrorToast } from "@/lib/errors";
import { squareImage } from "@/lib/image";
import { SettingRow } from "./setting-row";

export function ProfileCard() {
  const t = useTranslations();
  const viewer = useViewer();
  const updateProfile = useMutation(api.users.updateProfile);
  const generateUploadUrl = useMutation(api.users.generateAvatarUploadUrl);
  const setAvatar = useMutation(api.users.setAvatar);
  const removeAvatar = useMutation(api.users.removeAvatar);
  const setShowEmail = useMutation(api.users.setShowEmailPublicly);
  const showError = useErrorToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const [nameZh, setNameZh] = useState(viewer.nameZh ?? "");
  const [nameEn, setNameEn] = useState(viewer.nameEn ?? "");
  const [bio, setBio] = useState(viewer.bio ?? "");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);

  const dirty =
    nameZh !== (viewer.nameZh ?? "") || nameEn !== (viewer.nameEn ?? "") || bio !== (viewer.bio ?? "");

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await updateProfile({ nameZh, nameEn, bio });
      toast.success(t("settings.profileSaved"));
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  };

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      let image: Blob;
      try {
        image = await squareImage(file);
      } catch {
        toast.error(t("settings.avatarUnreadable"));
        return;
      }
      const uploadUrl = await generateUploadUrl();
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": image.type },
        body: image,
      });
      if (!response.ok) throw new Error(`upload ${response.status}`);
      const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
      await setAvatar({ storageId });
      toast.success(t("settings.avatarUpdated"));
    } catch (error) {
      showError(error);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.profile")}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="flex items-start gap-2 rounded-md bg-secondary px-3 py-2 text-xs text-muted-foreground">
          <EyeIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
          <span>
            {t("settings.publicNotice")}{" "}
            <Link href="/about-us/" className="text-primary underline-offset-4 hover:underline">
              {t("settings.publicPageLink")}
            </Link>
          </span>
        </p>

        <div className="flex items-center gap-4">
          <PersonAvatar person={viewer} className="size-16 text-base" />
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => void onPickFile(e.target.files?.[0])}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={uploading}
              onClick={() => fileInput.current?.click()}
            >
              <ImageUpIcon />
              {uploading ? t("common.saving") : viewer.hasCustomAvatar ? t("settings.changeAvatar") : t("settings.uploadAvatar")}
            </Button>
            {viewer.hasCustomAvatar ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={uploading}
                onClick={() => void removeAvatar().catch(showError)}
              >
                {t("settings.removeAvatar")}
              </Button>
            ) : null}
          </div>
        </div>

        <form onSubmit={onSave} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="s-nameZh">{t("onboarding.nameZh")}</Label>
              <Input id="s-nameZh" value={nameZh} maxLength={LIMITS.nameLength} onChange={(e) => setNameZh(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="s-nameEn">{t("onboarding.nameEn")}</Label>
              <Input id="s-nameEn" value={nameEn} maxLength={LIMITS.nameLength} onChange={(e) => setNameEn(e.target.value)} required />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="s-bio">
                {t("settings.bio")} <span className="text-muted-foreground">{t("common.optional")}</span>
              </Label>
              <span className="text-xs text-subtle-foreground">
                {bio.length}/{LIMITS.bio}
              </span>
            </div>
            <Textarea
              id="s-bio"
              rows={2}
              value={bio}
              maxLength={LIMITS.bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder={t("settings.bioPlaceholder")}
            />
          </div>
          <Button type="submit" className="self-end" disabled={!dirty || busy || !nameZh.trim() || !nameEn.trim()}>
            {busy ? t("common.saving") : t("common.save")}
          </Button>
        </form>

        <SettingRow
          label={t("settings.showEmailPublicly")}
          hint={t("settings.showEmailPubliclyHint", { email: viewer.email ?? "" })}
          htmlFor="show-email"
          className="border-t border-border pt-4"
        >
          <Switch
            id="show-email"
            checked={viewer.showEmailPublicly}
            onCheckedChange={(show) => void setShowEmail({ show }).catch(showError)}
          />
        </SettingRow>
      </CardContent>
    </Card>
  );
}
