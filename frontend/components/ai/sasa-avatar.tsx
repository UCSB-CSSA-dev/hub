import { cn } from "@/lib/utils";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** "think" while 小飒 waits for or streams an answer; "idle" otherwise. */
export type SasaState = "idle" | "think";

/** 小飒's animated avatar; reduced-motion users get the still first frame. */
export function SasaAvatar({
  state = "idle",
  className,
  label,
}: {
  state?: SasaState;
  className?: string;
  /** Accessible name; decorative when omitted. */
  label?: string;
}) {
  return (
    <picture className={cn("block size-8 shrink-0 overflow-hidden rounded-full bg-white", className)}>
      <source srcSet={`${BASE}/brand/${state}.png`} media="(prefers-reduced-motion: reduce)" />
      <img src={`${BASE}/brand/${state}-160.gif`} alt={label ?? ""} className="size-full object-cover" />
    </picture>
  );
}
