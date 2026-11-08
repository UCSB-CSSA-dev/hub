import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Label and hint on the left, the control on the right; stack rows inside `divide-y`. */
export function SettingRow({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0", className)}>
      <div className="min-w-0 flex-1 basis-48">
        <label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </label>
        {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}
