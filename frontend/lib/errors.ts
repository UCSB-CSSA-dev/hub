import { ConvexError } from "convex/values";
import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { toast } from "sonner";
import { ERROR_CODES } from "./api";

const KNOWN_CODES = new Set<string>(ERROR_CODES);

/** INVALID errors name the offending field; these have their own message. */
const INVALID_FIELDS = new Set([
  "title",
  "description",
  "location",
  "assignees",
  "departmentId",
  "startAt",
  "endAt",
  "eventId",
  "fileIds",
  "status",
  "name",
  "link",
  "rule",
  "memory_full",
]);

export function errorCode(error: unknown): string {
  if (error instanceof ConvexError) {
    const code = (error.data as { code?: string } | undefined)?.code;
    if (code && KNOWN_CODES.has(code)) return code;
  }
  return "UNKNOWN";
}

/** The `errors` message key for a failed call: the code, or `invalid.<field>` for a known field. */
export function errorKey(error: unknown): string {
  const code = errorCode(error);
  if (code === "INVALID") {
    const field = ((error as ConvexError<{ message?: string }>).data ?? {}).message;
    if (field && INVALID_FIELDS.has(field)) return `invalid.${field}`;
  }
  return code;
}

/** Returns a handler that shows a translated toast for a failed mutation. */
export function useErrorToast() {
  const t = useTranslations("errors");
  return useCallback((error: unknown) => toast.error(t(errorKey(error) as "INVALID")), [t]);
}
