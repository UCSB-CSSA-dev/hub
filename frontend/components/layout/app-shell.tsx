"use client";

import { useQuery } from "convex/react";
import {
  BellIcon,
  ClipboardListIcon,
  FolderIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  MessageSquareIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShieldIcon,
  SparklesIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { SasaFab } from "@/components/ai/sasa-fab";
import { useViewer } from "@/components/auth/account-state";
import { PushSync } from "@/components/notifications/push-sync";
import { PersonAvatar } from "@/components/people/person-avatar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { hasStoredLocale, setStoredLocale, type Locale } from "@/lib/locale-store";
import { displayName } from "@/lib/names";
import { useSignOut } from "@/lib/push";
import { cn } from "@/lib/utils";
import { BrandMark } from "./brand";
import { LanguageToggle } from "./language-toggle";
import { ThemeToggle } from "@/components/layout/theme-toggle";

type NavItem = {
  key:
    | "chat"
    | "notifications"
    | "roster"
    | "files"
    | "assignments"
    | "admin"
    | "adminOverview"
    | "auditLog"
    | "sasa"
    | "settings";
  href: string;
  icon: LucideIcon;
  disabled?: boolean;
  /** Only highlight on this exact path, not its sub-pages. */
  exact?: boolean;
  /** Also highlight under these paths. */
  section?: string[];
};

const CHAT: NavItem = { key: "chat", href: "/chat/", icon: MessageSquareIcon };
const NOTIFICATIONS: NavItem = { key: "notifications", href: "/notifications/", icon: BellIcon };
const ROSTER: NavItem = { key: "roster", href: "/roster/", icon: UsersIcon };
const FILES: NavItem = { key: "files", href: "/files/", icon: FolderIcon };
const ASSIGNMENTS: NavItem = { key: "assignments", href: "/assignments/", icon: ClipboardListIcon };
const MAIN_NAV: NavItem[] = [CHAT, FILES, ASSIGNMENTS];

const ADMIN_OVERVIEW: NavItem = { key: "adminOverview", href: "/admin/", icon: LayoutDashboardIcon, exact: true };
const AUDIT_LOG: NavItem = { key: "auditLog", href: "/admin/audit/", icon: ScrollTextIcon };
const SASA_ADMIN: NavItem = { key: "sasa", href: "/admin/ai/", icon: SparklesIcon };
const SETTINGS: NavItem = { key: "settings", href: "/settings/", icon: SettingsIcon };

// On phones several pages share one bottom tab, with a bar at the top to switch between them.
const MOBILE_ADMIN: NavItem = { key: "admin", href: "/roster/", icon: ShieldIcon, section: ["/roster/", "/admin/"] };

function useNav() {
  const viewer = useViewer();
  const unread = useQuery(api.notifications.unreadCount) ?? 0;
  const todo = useQuery(api.assignments.myOpenCount) ?? 0;
  const appeals = useQuery(api.ai.pendingAppealCount, viewer.isSystemAdmin ? {} : "skip") ?? 0;
  const isManager = viewer.isAdmin || viewer.ledDepartmentIds.length > 0;
  const counts: Partial<Record<NavItem["key"], number>> = {
    notifications: unread,
    assignments: todo,
    roster: viewer.reviewCount,
    admin: viewer.reviewCount + appeals,
    sasa: appeals,
  };
  // The roster is open to everyone; it sits with the admin pages because that's where people are managed.
  const admin = [
    ROSTER,
    ...(isManager ? [ADMIN_OVERVIEW] : []),
    ...(viewer.isAdmin ? [AUDIT_LOG] : []),
    ...(viewer.isSystemAdmin ? [SASA_ADMIN] : []),
  ];
  const mobile = [CHAT, FILES, ASSIGNMENTS, NOTIFICATIONS, MOBILE_ADMIN, SETTINGS];
  const mobileSections = [{ tab: MOBILE_ADMIN, items: admin }];
  return { main: MAIN_NAV, admin, mobile, mobileSections, counts };
}

export function AppShell({ children }: { children: ReactNode }) {
  const viewer = useViewer();

  useEffect(() => {
    if (!hasStoredLocale()) setStoredLocale(viewer.locale as Locale);
  }, [viewer.locale]);

  return (
    <div className="flex h-dvh flex-col pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] md:flex-row">
      <Sidebar />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col md:pb-[env(safe-area-inset-bottom)]">
        <MobileSectionTabs />
        {children}
      </main>
      <MobileNav />
      <SasaFab />
      <PushSync />
    </div>
  );
}

function useIsActive() {
  const pathname = usePathname();
  return (item: NavItem) =>
    pathname === item.href ||
    (!item.exact && pathname.startsWith(item.href)) ||
    (item.section?.some((path) => pathname.startsWith(path)) ?? false);
}

function Sidebar() {
  const t = useTranslations();
  const locale = useLocale() as Locale;
  const viewer = useViewer();
  const isActive = useIsActive();
  const signOut = useSignOut();
  const { main, admin, counts } = useNav();
  const settingsActive = isActive(SETTINGS);
  const notificationsActive = isActive(NOTIFICATIONS);
  const unread = counts.notifications ?? 0;

  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-sidebar md:flex">
      <div className="flex h-14 shrink-0 items-center justify-between pr-3 pl-4">
        <Link href="/chat/">
          <BrandMark className="h-10" />
        </Link>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              asChild
              size="icon-sm"
              variant="ghost"
              className={cn("relative", notificationsActive && "bg-accent text-primary")}
              aria-label={t("nav.notifications")}
            >
              <Link href={NOTIFICATIONS.href} aria-current={notificationsActive ? "page" : undefined}>
                <BellIcon />
                {unread > 0 ? <CountBadge count={unread} className="absolute -top-1 -right-1.5" /> : null}
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("nav.notifications")}</TooltipContent>
        </Tooltip>
      </div>
      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
        {main.map((item) => (
          <NavLink
            key={item.key}
            item={item}
            active={isActive(item)}
            label={t(`nav.${item.key}`)}
            count={counts[item.key] ?? 0}
          />
        ))}
        <div className="mt-auto flex flex-col gap-0.5 pt-4">
          <div className="px-2.5 pb-1 text-xs text-subtle-foreground">{t("nav.admin")}</div>
          {admin.map((item) => (
            <NavLink
              key={item.key}
              item={item}
              active={isActive(item)}
              label={t(`nav.${item.key}`)}
              count={counts[item.key] ?? 0}
            />
          ))}
        </div>
      </nav>
      <div className="flex flex-col gap-3 border-t border-border p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <div className="flex items-center gap-2">
          <PersonAvatar person={viewer} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">{displayName(viewer, locale)}</div>
            <div className="truncate text-xs text-muted-foreground">{viewer.email}</div>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                asChild
                size="icon-sm"
                variant="ghost"
                className={cn(settingsActive && "bg-accent text-primary")}
                aria-label={t("nav.settings")}
              >
                <Link href={SETTINGS.href} aria-current={settingsActive ? "page" : undefined}>
                  <SettingsIcon />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("nav.settings")}</TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2"><ThemeToggle /><LanguageToggle /></div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" variant="ghost" onClick={() => void signOut()} aria-label={t("common.signOut")}>
                <LogOutIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("common.signOut")}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </aside>
  );
}

function NavLink({
  item,
  active,
  label,
  count,
}: {
  item: NavItem;
  active: boolean;
  label: string;
  count: number;
}) {
  const t = useTranslations("common");
  const Icon = item.icon;
  const className = cn(
    "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
    active ? "bg-accent text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground",
  );

  if (item.disabled) {
    return (
      <div className={cn(className, "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground")}>
        <Icon className="size-4" />
        <span className="flex-1">{label}</span>
        <span className="text-[10px]">{t("comingSoon")}</span>
      </div>
    );
  }
  return (
    <Link href={item.href} className={className} aria-current={active ? "page" : undefined}>
      <Icon className="size-4" />
      <span className="flex-1">{label}</span>
      {count > 0 ? <CountBadge count={count} /> : null}
    </Link>
  );
}

function CountBadge({ count, className }: { count: number; className?: string }) {
  return (
    <span
      className={cn(
        "min-w-4.5 rounded-full bg-primary px-1 text-center text-[10px] leading-4.5 font-semibold text-primary-foreground",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

const NON_TEXT_INPUTS = new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]);

function takesTyping(el: Element | null) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(el.type);
}

function subscribeFocus(onChange: () => void) {
  // Focus leaves one field before entering the next; waiting a tick keeps the bar from flashing in between.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 0);
  };
  document.addEventListener("focusin", onChange);
  document.addEventListener("focusout", later);
  return () => {
    clearTimeout(timer);
    document.removeEventListener("focusin", onChange);
    document.removeEventListener("focusout", later);
  };
}

/** A touch keyboard is probably open: a field that takes typing has focus on a touch screen. */
function useKeyboardOpen() {
  return useSyncExternalStore(
    subscribeFocus,
    () => takesTyping(document.activeElement) && window.matchMedia("(pointer: coarse)").matches,
    () => false,
  );
}

function MobileNav() {
  const t = useTranslations("nav");
  const tc = useTranslations("common");
  const isActive = useIsActive();
  const { mobile, counts } = useNav();
  const keyboardOpen = useKeyboardOpen();
  // The bar would otherwise ride up on top of the keyboard and squeeze the page.
  if (keyboardOpen) return null;
  return (
    <nav className="flex shrink-0 border-t border-border bg-sidebar pb-[calc(env(safe-area-inset-bottom)*1.15)] md:hidden">
      {mobile.map((item) => {
        const Icon = item.icon;
        const active = isActive(item);
        const count = counts[item.key] ?? 0;
        const className = "relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px]";
        if (item.disabled) {
          return (
            <div
              key={item.key}
              aria-disabled
              title={tc("comingSoon")}
              className={cn(className, "cursor-not-allowed text-muted-foreground opacity-40")}
            >
              <Icon className="size-5" />
              {t(item.key)}
            </div>
          );
        }
        return (
          <Link
            key={item.key}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(className, active ? "text-primary" : "text-muted-foreground")}
          >
            <Icon className="size-5" />
            {count > 0 ? <CountBadge count={count} className="absolute top-1 left-1/2 ml-1.5" /> : null}
            {t(item.key)}
          </Link>
        );
      })}
    </nav>
  );
}

/** The switcher for the bottom tab that covers the current page, when that tab holds more than one page. */
function MobileSectionTabs() {
  const t = useTranslations("nav");
  const isActive = useIsActive();
  const { mobileSections, counts } = useNav();
  const section = mobileSections.find(({ tab, items }) => items.length > 1 && isActive(tab));
  if (!section) return null;
  return (
    <nav aria-label={t(section.tab.key)} className="flex shrink-0 gap-1 border-b border-border px-3 py-2 md:hidden">
      {section.items.map((item) => {
        const Icon = item.icon;
        const active = isActive(item);
        const count = counts[item.key] ?? 0;
        return (
          <Link
            key={item.key}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors",
              active ? "bg-accent text-primary" : "text-muted-foreground",
            )}
          >
            <Icon className="size-4" />
            {t(item.key)}
            {count > 0 ? <CountBadge count={count} /> : null}
          </Link>
        );
      })}
    </nav>
  );
}

/** Page header used by app pages; holds the title and page-level actions. */
export function PageHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
      <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{title}</h1>
      {children}
    </header>
  );
}
