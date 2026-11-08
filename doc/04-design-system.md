# 04 Design System

## Principles

- **Minimal and quiet.** Neutral surfaces, contrasting text, one accent color. No gradients, heavy shadows, or decorative illustrations.
- **Gold means attention.** Use gold/yellow only for primary actions, active navigation, unread badges, mentions, and important states. If everything is gold, nothing is.
- **Content first.** Chat messages, file names, and assignment titles should be the most readable things on the screen.
- **Dark and light.** Default to dark; the theme toggle saves the browser's choice and restores it before paint.

## Logo

There are two sources in `frontend/assets/brand/`:

- `logo.webp`: the UCSB CSSA phoenix lockup (transparent, dark text). Its text is unreadable on our dark surfaces, so the UI uses derived versions.
- `app-icon.webp`: a square app icon, 1024px. It shows an upright phoenix in the logo's flame colors with the teal chest jewel, full bleed on black. The logo's wide phoenix is too small to read as an icon.

`npm run brand --workspace frontend` (`frontend/scripts/brand-assets.mjs`) generates everything else:

| File | What it is | Where it's used |
| --- | --- | --- |
| `assets/brand/logo-on-dark.webp` | Full lockup with the text recolored light | Above the card on sign-in, onboarding, pending, rejected (`BrandLogo`) |
| `assets/brand/logo-mark.webp` | Phoenix + "UCSB CSSA", no text block | Sidebar, privacy page header, full-screen loading, followed by a gold "Hub" (`BrandMark`) |
| `app/icon.png` | App icon, 128px | Favicon, push notification icon |
| `app/apple-icon.png` | App icon, 180px | iOS home-screen icon |
| `public/brand/icon-{192,512}.png` | App icon | Web app manifest (Android home screen, install prompts) |

The app icons shrink the art to 90% on black so the wingtips clear the rounded corners that iOS and Android apply.

Both components live in `components/layout/brand.tsx` and use static imports, so the URLs pick up the GitHub Pages base path. Don't reference the logo from `public/` with a hard-coded path. After replacing a source, rerun the script; if the layout of the logo changes, re-measure the crop boxes at the top of the script.

## Color tokens

| Token | Hex | Usage |
| --- | --- | --- |
| `background` | `#0a0a0a` | App background |
| `surface` (`card`, `popover`) | `#171717` | Cards, sidebar, dialogs, menus |
| `surface-hover` (`accent` in shadcn) | `#1f1f1f` | Hover rows, selected list items |
| `border` / `input` | `#262626` | Dividers, input borders |
| `foreground` | `#fafafa` | Normal text |
| `muted-foreground` | `#a3a3a3` | Secondary text, timestamps, placeholders |
| `subtle-foreground` | `#737373` | Disabled text, tertiary info |
| `primary` (gold) | `#eab308` | Primary buttons, active nav, badges, focus ring, links |
| `primary-hover` | `#facc15` | Hover on primary |
| `primary-foreground` | `#0a0a0a` | Text on gold backgrounds |
| `gold-muted` | `rgba(234, 179, 8, 0.12)` | Mention highlight background, oversight banner background |
| `destructive` | `#ef4444` | Delete, reject, errors |
| `success` | `#22c55e` | Approved, completed (use sparingly) |
| `warning` | `#f59e0b` | Due soon, late |

Rules:

- Text on `background` and `surface` must be `foreground` or `muted-foreground` for contrast.
- Always use `primary-foreground` on gold: near black in dark mode, white on the deeper gold in light mode.
- Status chips use a tinted background (12% opacity of the color) with the full color for text.

## shadcn/ui theme

Initialize shadcn with the "neutral" base and override the CSS variables in `app/globals.css`. The root uses either `.dark` or `.light`. The color table above describes dark mode; light mode uses `#fafafa` backgrounds, white cards, `#171717` text, and `#856300` gold for readable contrast. `BrandLogo` uses the original dark-text logo in light mode.

```css
:root,
.dark {
  --background: #0a0a0a;
  --foreground: #fafafa;
  --card: #171717;
  --card-foreground: #fafafa;
  --popover: #171717;
  --popover-foreground: #fafafa;
  --primary: #eab308;
  --primary-foreground: #0a0a0a;
  --secondary: #262626;
  --secondary-foreground: #fafafa;
  --muted: #171717;
  --muted-foreground: #a3a3a3;
  --accent: #1f1f1f;
  --accent-foreground: #fafafa;
  --destructive: #ef4444;
  --border: #262626;
  --input: #262626;
  --ring: #eab308;
  --radius: 0.5rem;

  --sidebar: #111111;
  --sidebar-foreground: #fafafa;
  --sidebar-primary: #eab308;
  --sidebar-primary-foreground: #0a0a0a;
  --sidebar-accent: #1f1f1f;
  --sidebar-accent-foreground: #fafafa;
  --sidebar-border: #262626;
  --sidebar-ring: #eab308;
}
```

If the installed shadcn version uses `oklch()` values, convert these hex values but keep the same colors.

## Typography

Use system fonts only, no web font downloads. The stack covers English and Simplified Chinese on macOS, Windows, iOS, Android, and Linux:

```css
--font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
  "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", "Noto Sans CJK SC",
  "Helvetica Neue", Arial, sans-serif;
--font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
```

| Role | Size / weight | Tailwind |
| --- | --- | --- |
| Page title | 20px / 600 | `text-xl font-semibold` |
| Section title | 16px / 600 | `text-base font-semibold` |
| Body, messages | 14px / 400, line-height 1.6 | `text-sm leading-relaxed` |
| Secondary, timestamps | 12px / 400 | `text-xs text-muted-foreground` |

Chinese text needs slightly more line height than English. Keep `leading-relaxed` for body text.

## Spacing, radius, borders

- 4px spacing grid (Tailwind default). Common paddings: `p-3` for list rows, `p-4` for cards, `p-6` for pages.
- Radius: `rounded-md` (6px) for inputs and buttons, `rounded-lg` (8px) for cards and dialogs.
- Separate areas with 1px `border-border` lines instead of shadows.

## Layout

```text
+------------+-------------------------------------------------+
|  CSSA Hub  |  Page header (title, actions)                   |
|            |-------------------------------------------------|
|  Chat      |                                                 |
|  Files     |                                                 |
|  Tasks     |              Main content                       |
|  Notices   |                                                 |
|  Admin     |                                                 |
|            |                                                 |
|  --------  |                                                 |
|  avatar    |                                                 |
|  中/EN     |                                                 |
+------------+-------------------------------------------------+
```

- Desktop (1024px and up): fixed left sidebar, 240px wide, collapsible to icons (64px). Chat adds a second column for the channel list (280px).
- Tablet (768 to 1023px): sidebar collapsed to icons by default. Chat shows the channel list and the conversation as separate screens, with a back arrow in the conversation header.
- Mobile (under 768px): bottom tab bar with Chat, Files, Tasks, Notices, More. List and detail views become separate screens. The tab bar stays at the bottom of the screen and hides while a text field has focus on a touch screen, so it never rides up on top of the keyboard.
- Safe areas: the viewport uses `viewport-fit=cover`, so anything that touches a screen edge pads itself with `env(safe-area-inset-*)`. That covers the iPhone home indicator, the notch in landscape, and the iOS home-screen app. The app shell pads the top and sides; the bottom tab bar, the sidebar footer, the main column on tablets and every sheet pad the bottom. The tab bar gets 15% extra so its labels sit clearly above the home indicator.
- Active nav item: gold text and a 2px gold left border, no filled background.
- The language toggle (中 / EN) and the user menu sit at the bottom of the sidebar.

## Components (shadcn/ui)

Use these shadcn components before building custom ones:

| Need | Component |
| --- | --- |
| Navigation | `sidebar`, `sheet` (mobile), `breadcrumb` |
| Actions | `button`, `dropdown-menu`, `context-menu` |
| Forms | `form`, `input`, `textarea`, `select`, `checkbox`, `calendar` + `popover` (date picker), `command` (people picker) |
| Overlays | `dialog`, `alert-dialog` (destructive confirms), `drawer` (mobile) |
| Data | `table`, `tabs`, `badge`, `avatar`, `scroll-area`, `skeleton` |
| Feedback | `sonner` (toasts), `tooltip`, `progress` |

Button variants: `default` = gold primary (one per view, at most), `secondary` = dark gray, `ghost` for toolbar icons, `destructive` for delete or reject.

## Specific patterns

- **Unread badge**: gold pill with dark text, `text-xs font-semibold`, "99+" cap.
- **Mention in a message**: gold text; the whole message row gets the `gold-muted` background when it mentions the viewer.
- **Oversight banner**: full-width bar at the top of the content, `gold-muted` background, gold eye icon, text "监督查看模式（只读）/ Oversight view (read-only)".
- **Status chips (assignments)**: assigned = gray, in progress = blue-gray, submitted = gold, changes requested = warning, approved = success, late = destructive outline.
- **Empty states**: one line of muted text and an optional gold primary action. No illustrations.
- **Loading**: `skeleton` rows, not spinners, for lists.
- **Icons**: `lucide-react` (bundled with shadcn), 16px in lists, 20px in navigation.

## Accessibility

- All interactive elements are keyboard reachable with a visible gold focus ring (`ring-2 ring-ring`).
- Color is never the only signal: badges have text, status chips have labels.
- Minimum contrast 4.5:1 for body text (white and `#a3a3a3` on `#0a0a0a` both pass).
- Set `lang="zh-CN"` or `lang="en"` on `<html>` to match the current locale.
