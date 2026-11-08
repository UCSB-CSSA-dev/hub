"use client";

import { useTiptapSync } from "@convex-dev/prosemirror-sync/tiptap";
import type { AnyExtension, Content, Editor } from "@tiptap/core";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import {
  AtSignIcon,
  BoldIcon,
  CodeIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ItalicIcon,
  LinkIcon,
  ListChecksIcon,
  ListIcon,
  ListOrderedIcon,
  MinusIcon,
  QuoteIcon,
  Redo2Icon,
  SquareCodeIcon,
  StrikethroughIcon,
  Undo2Icon,
  type LucideIcon,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { UserSummaryLike } from "@/components/people/types";
import { api } from "@/lib/api";
import { useEnterSubmit } from "@/lib/keyboard";
import type { Locale } from "@/lib/locale-store";
import { cn } from "@/lib/utils";
import { docExtensions, looksLikeMarkdown } from "./extensions";
import { mentionSuggestion, PeopleSource } from "./mention-suggestion";

/**
 * A document, edited live by everyone who has it open (prosemirror-sync over Convex).
 * Markdown shortcuts render as you type ("# ", "- ", "**bold**", "```"), pasted markdown is rendered,
 * and "@" mentions someone from `mentionable`.
 */
export function DocEditor({
  documentId,
  editable,
  mentionable,
  onEditor,
}: {
  documentId: string;
  editable: boolean;
  mentionable: UserSummaryLike[];
  onEditor?: (editor: Editor | null) => void;
}) {
  const t = useTranslations("docs");
  const sync = useTiptapSync(api.prosemirror, documentId, {
    onSyncError: () => toast.error(t("syncError"), { id: "doc-sync" }),
  });
  if (sync.isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    );
  }
  if (sync.initialContent === null) return <p className="text-sm text-muted-foreground">{t("notFound")}</p>;
  return (
    <LoadedEditor
      key={documentId}
      initialContent={sync.initialContent}
      extension={sync.extension}
      editable={editable}
      mentionable={mentionable}
      onEditor={onEditor}
    />
  );
}

function LoadedEditor({
  initialContent,
  extension,
  editable,
  mentionable,
  onEditor,
}: {
  initialContent: Content;
  extension: AnyExtension;
  editable: boolean;
  mentionable: UserSummaryLike[];
  onEditor?: (editor: Editor | null) => void;
}) {
  const t = useTranslations("docs");
  const locale = useLocale() as Locale;
  const editorRef = useRef<Editor | null>(null);
  // Suggestions read the latest list on each keystroke, so a changed list doesn't rebuild the editor.
  const [people] = useState(() => new PeopleSource(mentionable));
  useEffect(() => {
    people.set(mentionable);
  }, [people, mentionable]);
  const extensions = useMemo(
    () => [...docExtensions(t("placeholder"), mentionSuggestion(() => people.get(), locale)), extension],
    [extension, t, locale, people],
  );
  const editor = useEditor(
    {
      extensions,
      content: initialContent,
      editable,
      immediatelyRender: false,
      editorProps: {
        attributes: { class: "doc-content min-h-[50vh] pb-24 focus:outline-none" },
        handlePaste: (_view, event) => {
          const data = event.clipboardData;
          if (!data || data.types.includes("text/html")) return false;
          const text = data.getData("text/plain");
          if (!editorRef.current || !looksLikeMarkdown(text)) return false;
          editorRef.current.commands.insertContent(text, { contentType: "markdown" });
          return true;
        },
      },
    },
    [extensions],
  );

  useEffect(() => {
    editorRef.current = editor;
    onEditor?.(editor);
    return () => onEditor?.(null);
  }, [editor, onEditor]);

  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  return (
    <div className="flex flex-col gap-3">
      {editor && editable ? <Toolbar editor={editor} /> : null}
      <EditorContent editor={editor} />
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const t = useTranslations("docs");
  const [linkOpen, setLinkOpen] = useState(false);
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      h1: e.isActive("heading", { level: 1 }),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      task: e.isActive("taskList"),
      quote: e.isActive("blockquote"),
      codeBlock: e.isActive("codeBlock"),
      link: e.isActive("link"),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const chain = () => editor.chain().focus();
  const groups: { icon: LucideIcon; label: string; active?: boolean; disabled?: boolean; run: () => void }[][] = [
    [
      { icon: Undo2Icon, label: t("undo"), disabled: !state.canUndo, run: () => chain().undo().run() },
      { icon: Redo2Icon, label: t("redo"), disabled: !state.canRedo, run: () => chain().redo().run() },
    ],
    [
      { icon: Heading1Icon, label: t("heading1"), active: state.h1, run: () => chain().toggleHeading({ level: 1 }).run() },
      { icon: Heading2Icon, label: t("heading2"), active: state.h2, run: () => chain().toggleHeading({ level: 2 }).run() },
      { icon: Heading3Icon, label: t("heading3"), active: state.h3, run: () => chain().toggleHeading({ level: 3 }).run() },
    ],
    [
      { icon: BoldIcon, label: t("bold"), active: state.bold, run: () => chain().toggleBold().run() },
      { icon: ItalicIcon, label: t("italic"), active: state.italic, run: () => chain().toggleItalic().run() },
      { icon: StrikethroughIcon, label: t("strike"), active: state.strike, run: () => chain().toggleStrike().run() },
      { icon: CodeIcon, label: t("code"), active: state.code, run: () => chain().toggleCode().run() },
      { icon: LinkIcon, label: t("link"), active: state.link, run: () => setLinkOpen(true) },
      { icon: AtSignIcon, label: t("mention"), run: () => chain().insertContent("@").run() },
    ],
    [
      { icon: ListIcon, label: t("bulletList"), active: state.bullet, run: () => chain().toggleBulletList().run() },
      { icon: ListOrderedIcon, label: t("orderedList"), active: state.ordered, run: () => chain().toggleOrderedList().run() },
      { icon: ListChecksIcon, label: t("taskList"), active: state.task, run: () => chain().toggleTaskList().run() },
      { icon: QuoteIcon, label: t("quote"), active: state.quote, run: () => chain().toggleBlockquote().run() },
      { icon: SquareCodeIcon, label: t("codeBlock"), active: state.codeBlock, run: () => chain().toggleCodeBlock().run() },
      { icon: MinusIcon, label: t("divider"), run: () => chain().setHorizontalRule().run() },
    ],
  ];

  return (
    <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-0.5 rounded-md border border-border bg-card/95 p-1 backdrop-blur print:hidden">
      {groups.map((group, i) => (
        <div key={i} className={cn("flex items-center gap-0.5", i > 0 && "border-l border-border pl-0.5")}>
          {group.map(({ icon: Icon, label, active, disabled, run }) => (
            <Tooltip key={label}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={label}
                  aria-pressed={active}
                  disabled={disabled}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={run}
                  className={cn(active && "bg-primary/15 text-primary hover:bg-primary/20 hover:text-primary")}
                >
                  <Icon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      ))}
      <LinkDialog key={String(linkOpen)} editor={editor} open={linkOpen} onClose={() => setLinkOpen(false)} />
    </div>
  );
}

function LinkDialog({ editor, open, onClose }: { editor: Editor; open: boolean; onClose: () => void }) {
  const t = useTranslations("docs");
  const [url, setUrl] = useState(() => (editor.getAttributes("link").href as string | undefined) ?? "");
  const apply = () => {
    const href = url.trim();
    const chain = editor.chain().focus().extendMarkRange("link");
    if (!href) chain.unsetLink().run();
    else chain.setLink({ href: /^(https?:|mailto:)/i.test(href) ? href : `https://${href}` }).run();
    onClose();
  };
  const enter = useEnterSubmit(apply);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("link")}</DialogTitle>
          <DialogDescription>{t("linkBody")}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={url}
          placeholder="https://"
          onChange={(e) => setUrl(e.target.value)}
          {...enter}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button onClick={apply}>{t("save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
