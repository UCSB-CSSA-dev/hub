"use client";

import type { Editor } from "@tiptap/core";
import { MicIcon, MicOffIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// Live transcription with the browser's Web Speech API (no 小飒, no credits). Chrome and Edge send the
// audio to their speech service; Safari may recognize on the device; Firefox has no support.

type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
type RecognitionEvent = { resultIndex: number; results: ArrayLike<RecognitionResult> };
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

export type DictationLang = "zh-CN" | "en-US";

const LANG_KEY = "cssa-hub:dictation-lang";
/** A dictated paragraph longer than this starts a new one at the next pause. */
const PARAGRAPH_CHARS = 300;

function recognitionClass(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const noop = () => () => {};

export function useDictationSupported() {
  return useSyncExternalStore(
    noop,
    () => recognitionClass() !== null,
    () => false,
  );
}

/** Appends recognized speech to the end of the document, a sentence at a time. */
function appendSpeech(editor: Editor, text: string) {
  const chunk = text.trim();
  if (!chunk) return;
  const { doc } = editor.state;
  const last = doc.lastChild;
  const cjk = /^[\u3000-\u9fff\uff00-\uffef]/.test(chunk);
  if (last && last.type.name === "paragraph" && last.textContent.length < PARAGRAPH_CHARS) {
    const joiner = last.textContent.length === 0 || cjk || /[\u3000-\u9fff]$/.test(last.textContent) ? "" : " ";
    editor.commands.insertContentAt(doc.content.size - 1, joiner + chunk);
  } else {
    editor.commands.insertContentAt(doc.content.size, { type: "paragraph", content: [{ type: "text", text: chunk }] });
  }
}

export function useDictation(editor: Editor | null) {
  const t = useTranslations("docs");
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [lang, setLangState] = useState<DictationLang>(() => {
    if (typeof window === "undefined") return "zh-CN";
    return window.localStorage.getItem(LANG_KEY) === "en-US" ? "en-US" : "zh-CN";
  });
  const recognition = useRef<Recognition | null>(null);
  const wanted = useRef(false);
  const editorRef = useRef(editor);
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  const stop = useCallback(() => {
    wanted.current = false;
    recognition.current?.stop();
    recognition.current = null;
    setListening(false);
    setInterim("");
  }, []);

  const start = useCallback(
    (language: DictationLang = lang) => {
      const Recognizer = recognitionClass();
      if (!Recognizer || !editorRef.current) return;
      recognition.current?.abort();
      const rec = new Recognizer();
      rec.lang = language;
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (event) => {
        let pending = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) {
            if (editorRef.current?.isEditable) appendSpeech(editorRef.current, result[0].transcript);
          } else {
            pending += result[0].transcript;
          }
        }
        setInterim(pending);
      };
      rec.onerror = (event) => {
        if (event.error === "no-speech" || event.error === "aborted") return;
        wanted.current = false;
        toast.error(event.error === "not-allowed" || event.error === "service-not-allowed" ? t("dictationDenied") : t("dictationError"));
      };
      // Browsers end recognition after a pause; keep going until the member stops.
      rec.onend = () => {
        if (wanted.current && recognition.current === rec) {
          try {
            rec.start();
            return;
          } catch {
            // Falls through to stopping.
          }
        }
        if (recognition.current === rec) {
          recognition.current = null;
          setListening(false);
          setInterim("");
        }
      };
      recognition.current = rec;
      wanted.current = true;
      try {
        rec.start();
        setListening(true);
      } catch {
        wanted.current = false;
        recognition.current = null;
        toast.error(t("dictationError"));
      }
    },
    [lang, t],
  );

  const setLang = useCallback(
    (next: DictationLang) => {
      setLangState(next);
      window.localStorage.setItem(LANG_KEY, next);
      if (wanted.current) start(next);
    },
    [start],
  );

  useEffect(
    () => () => {
      wanted.current = false;
      recognition.current?.abort();
    },
    [],
  );

  return { listening, interim, lang, setLang, start, stop };
}

export type Dictation = ReturnType<typeof useDictation>;

/** The mic toggle and language choice shown to editors. */
export function DictationControl({ dictation, disabled }: { dictation: Dictation; disabled?: boolean }) {
  const t = useTranslations("docs");
  const supported = useDictationSupported();
  const button = (
    <Button
      size="sm"
      variant={dictation.listening ? "default" : "outline"}
      disabled={!supported || disabled}
      aria-pressed={dictation.listening}
      onClick={() => (dictation.listening ? dictation.stop() : dictation.start())}
    >
      {dictation.listening ? <MicOffIcon /> : <MicIcon />}
      {dictation.listening ? t("dictationStop") : t("dictation")}
    </Button>
  );
  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          {/* A span keeps the tooltip working while the button is disabled. */}
          <span tabIndex={supported ? undefined : 0}>{button}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{supported ? t("dictationHint") : t("dictationUnsupported")}</TooltipContent>
      </Tooltip>
      <Select value={dictation.lang} onValueChange={(value) => dictation.setLang(value as DictationLang)}>
        <SelectTrigger size="sm" className="w-24" aria-label={t("dictationLanguage")} disabled={!supported || disabled}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="zh-CN">中文</SelectItem>
          <SelectItem value="en-US">English</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

/** What's being heard right now, pinned to the bottom while dictating. */
export function DictationBar({ dictation }: { dictation: Dictation }) {
  const t = useTranslations("docs");
  if (!dictation.listening) return null;
  return (
    <div className="sticky bottom-3 z-10 mx-auto flex w-full max-w-xl items-start gap-2 rounded-lg border border-primary/40 bg-card/95 px-3 py-2 text-sm shadow-md backdrop-blur print:hidden">
      <span className="relative mt-1.5 flex size-2.5 shrink-0">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-destructive/60 motion-reduce:animate-none" />
        <span className="relative inline-flex size-2.5 rounded-full bg-destructive" />
      </span>
      <div className="min-w-0 flex-1">
        <p className={dictation.interim ? "text-foreground" : "text-muted-foreground italic"}>
          {dictation.interim || t("dictationListening")}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{t("dictationPrivacy")}</p>
      </div>
      <Button size="xs" variant="ghost" onClick={dictation.stop}>
        {t("dictationStop")}
      </Button>
    </div>
  );
}
