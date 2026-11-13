# CSSA Hub (UCSB CSSA 内部平台)

An internal web platform for **UCSB CSSA** (Chinese Students and Scholars Association). It combines three tools the organization currently spreads across several apps:

| Pillar | Replaces | Summary |
| --- | --- | --- |
| **Chat 聊天** | GroupMe / WeChat groups | Real-time department channels, group chats, DMs, announcements |
| **Files 文件** | Google Drive | Department-scoped folders, uploads, previews |
| **Assignments 任务** | Canvas | Leads assign tasks with due dates; members submit; leads review |

On top of these, the AI assistant **小飒 (Sasa)** answers questions about tasks, events, discussions and documents, turns tasks handed out in chat into real tasks, and summarizes and writes documents; documents also have browser dictation ([spec](doc/features/ai-assistant.md)).

A **roster** page shows the whole organization hierarchy (主席团, departments, 部长, 部员) to every member.

Access is limited to `@ucsb.edu` Google accounts. Every account must be **approved by an admin or lead**, or have its email **pre-approved** into a department beforehand. The first account ever created becomes the **system admin**. Officers have oversight over the content of the people they manage (see [Roles & Permissions](doc/02-roles-and-permissions.md)).

> Status: **Stages 1 to 4 implemented** (hierarchy and sign-in, full chat and oversight, files, tasks and the email digest, and the AI assistant 小飒). Next up: Stage 5 (polish). See [doc/09-roadmap.md](doc/09-roadmap.md). The docs in `doc/` are the source of truth for what to build.

---

## Tech stack

| Layer | Choice |
| --- | --- |
| Frontend | Next.js (App Router), React, TypeScript, built as a **static export** and hosted on GitHub Pages |
| UI | TailwindCSS + shadcn/ui, dark theme (black / dark gray background, white text, gold accent) |
| Backend | Convex (database, server functions, real-time subscriptions, file storage, crons) |
| Auth | Convex Auth with Google OAuth, restricted to `@ucsb.edu`, admin approval or email pre-approval required |
| Email | Google Apps Script web app that sends through Gmail, called from Convex actions (Stage 3) |
| AI | UCSB L&S AI service (OpenAI-compatible), called from Convex actions; key in Convex environment variables (Stage 4) |
| i18n | `next-intl` (client-side), Chinese (`zh`) default, English (`en`) secondary, toggle in UI |
| CI/CD | GitHub Actions: checks on every PR into `dev` and `stable`; on `stable`, deploy Convex and publish the site to GitHub Pages |

**Github Workflow**: When making a change/feature/bug create a new branch based on `dev`, after applying the changes, make a pull request to merge the new branch to `dev`, only requiring CI to pass. When there are a few changes in `dev`, one can make a PR to merge `dev` to `stable` and requiring CI to pass and approval from 1 other reviewer.

**Branch Naming Rule**: If it relates to an issue, include the issue number, such as `issue-1-bug-fix-over...` or `issue-12-new-feature-on`.

---

## Documentation index

Read in this order when starting fresh:

1. [doc/00-overview.md](doc/00-overview.md): vision, goals, non-goals, glossary (中英术语表)
2. [doc/01-architecture.md](doc/01-architecture.md): system diagram, routes, Convex function layout, data flows
3. [doc/02-roles-and-permissions.md](doc/02-roles-and-permissions.md): 主席团 / 部长 / 部员, permission matrix, visibility, audit log, signup disclosure
4. [doc/03-data-model.md](doc/03-data-model.md): Convex schema draft with indexes
5. Feature specs:
   - [doc/features/accounts-and-onboarding.md](doc/features/accounts-and-onboarding.md)
   - [doc/features/roster.md](doc/features/roster.md)
   - [doc/features/chat.md](doc/features/chat.md)
   - [doc/features/files.md](doc/features/files.md)
   - [doc/features/assignments.md](doc/features/assignments.md)
   - [doc/features/notifications-and-email.md](doc/features/notifications-and-email.md)
   - [doc/features/admin-console.md](doc/features/admin-console.md)
   - [doc/features/ai-assistant.md](doc/features/ai-assistant.md)
6. [doc/04-design-system.md](doc/04-design-system.md): colors, typography, layout, shadcn theme
7. [doc/05-i18n.md](doc/05-i18n.md): bilingual UI and data
8. [doc/06-email-apps-script.md](doc/06-email-apps-script.md): Gmail via Google Apps Script contract
9. [doc/07-security-and-privacy.md](doc/07-security-and-privacy.md): auth checks, file access, secrets, retention
10. [doc/08-conventions.md](doc/08-conventions.md): code structure, naming, Convex patterns, testing
11. [doc/09-roadmap.md](doc/09-roadmap.md): build stages and exit criteria (start with Stage 1)
12. [doc/10-open-questions.md](doc/10-open-questions.md): undecided items, to resolve before building the related feature

---

## Agent instructions

These rules apply to any coding agent (Cursor, Claude, Codex, etc.) working in this repo.

### Before writing code

1. Read this README, then `doc/00-overview.md`, `doc/02-roles-and-permissions.md`, and `doc/03-data-model.md`.
2. Read the feature spec in `doc/features/` for the area you are touching.
3. Check `doc/10-open-questions.md`. If your task depends on an open question, **ask the user** instead of guessing, or implement the default listed there and say so.
4. Check `doc/09-roadmap.md` to confirm which stage the work belongs to. Do not build later-stage features unless asked. Feature specs describe the full feature; each one says which parts belong to Stage 1.

### While writing code

- Follow [doc/08-conventions.md](doc/08-conventions.md) for structure and naming.
- **Every Convex query, mutation, and action that touches user data must check permissions on the server** using the helpers described in `doc/02-roles-and-permissions.md`. Never rely on the UI to hide data.
- Users with `status !== "approved"` may only call onboarding functions.
- All user-facing strings go through `next-intl`. Add keys to **both** `frontend/messages/zh.json` and `frontend/messages/en.json`. Never hard-code display text in components.
- The frontend is a **static export** (GitHub Pages). Do not use middleware, server actions, route handlers, cookies, or dynamic route segments. Put IDs in query params (`/chat/?c=<channelId>`) and keep data access in Convex. See [doc/01-architecture.md](doc/01-architecture.md#static-export-constraints).
- Use the design tokens in `doc/04-design-system.md`. Do not introduce new colors or fonts.
- Use shadcn/ui components before writing custom ones.
- Secrets (Apps Script URL, shared secret, OAuth credentials, the AI API key) live in Convex environment variables, never in the repo. Locally the AI key sits in the gitignored root `.env`; never commit it or print its value.

### Keeping docs in sync

- The docs are the spec. If you change behavior, schema, routes, or permissions, **update the matching doc in the same change**.
- When an open question is resolved, move it out of `doc/10-open-questions.md` into the relevant doc and note the decision.
- Keep docs in English (code language), with Chinese terms in parentheses where they help (e.g. "Department Lead (部长)").

---

## Repository structure

npm workspaces with two packages. The frontend imports the backend's generated API types and shared constants as `@cssa-hub/backend`.

```text
.
├── README.md                    # this file
├── doc/                         # specifications (source of truth)
├── .github/workflows/
│   ├── ci.yml                   # lint, typecheck, tests, i18n check, static build
│   └── deploy.yml               # stable: Convex deploy + GitHub Pages
├── backend/                     # @cssa-hub/backend (Convex)
│   ├── convex/
│   │   ├── schema.ts, auth.ts, auth.config.ts, http.ts
│   │   ├── users.ts, departments.ts, memberships.ts, preApprovals.ts,
│   │   ├── roster.ts, channels.ts, messages.ts, seed.ts
│   │   ├── ai.ts, aiActions.ts  # 小飒: credits, AI mode, appeals, suggestions; model calls
│   │   ├── aiDocs.ts            # 小飒 and documents: summaries, writing, attachable documents
│   │   ├── lib/                 # permissions, constants (shared with frontend), audit, ai/, ...
│   │   └── _generated/          # committed; regenerated by `npx convex dev`
│   ├── scripts/push-ai-env.mjs  # `npm run ai:env`: copies AI_* from the root .env into Convex
│   └── tests/                   # convex-test + Vitest
└── frontend/                    # @cssa-hub/frontend (Next.js static export)
    ├── app/
    │   ├── (auth)/              # sign-in, onboarding, pending, rejected
    │   └── (app)/               # authenticated shell: chat, roster, settings
    ├── components/
    │   ├── ui/                  # shadcn/ui generated components
    │   └── <feature>/           # auth, chat, roster, people, layout, providers
    ├── lib/                     # api re-export, locale store, names, errors
    ├── messages/                # zh.json, en.json
    └── scripts/check-i18n.mjs
```

Later stages add `backend/convex/files.ts`, `assignments.ts`, `notifications.ts`, `email.ts`, `crons.ts`, and a `google-apps-script/` folder for the email relay.

## Getting started (local development)

Requires Node 22 (`.nvmrc`).

```bash
npm install

# 1. Link backend/ to your Convex project (writes backend/.env.local), once
cd backend
npx convex dev --configure existing --once

# 2. Auth keys and settings on the dev deployment, once
npx @convex-dev/auth --web-server-url http://localhost:3000   # JWT_PRIVATE_KEY, JWKS, SITE_URL
npx convex env set AUTH_GOOGLE_ID <client id>
npx convex env set AUTH_GOOGLE_SECRET <client secret>
npx web-push generate-vapid-keys            # then set both keys for push notifications:
npx convex env set VAPID_PUBLIC_KEY <public key>
npx convex env set VAPID_PRIVATE_KEY <private key>
cd ..

# Optional: 小飒. Put AI_API_KEY=... (and any other AI_* settings) in the root .env, then
npm run ai:env --workspace backend          # copies AI_* into the dev deployment without printing them

# 3. Every day: Convex (pushes functions on save) + Next.js on http://localhost:3000
npm run dev
```

The frontend reads `CONVEX_URL` from `backend/.env.local` automatically; `frontend/.env.local` is only needed to point at a different deployment. `npm run dev:backend` and `npm run dev:frontend` run the two halves separately.

Google OAuth client (Google Cloud Console, "Web application"): add the authorized redirect URI `https://<deployment>.convex.site/api/auth/callback/google` (the `.convex.site` URL of each Convex deployment, dev and prod).

Checks, same as CI: `npm run lint`, `npm run typecheck`, `npm test`, `npm run check:i18n`, `npm run build`.

All environment variables are listed in [doc/07-security-and-privacy.md](doc/07-security-and-privacy.md#secrets-and-environment-variables).

The **first account to sign in becomes system admin**. In production, set `BOOTSTRAP_ADMIN_EMAIL` so only the intended person can claim it.

## Deployment (GitHub Pages + Convex)

Pushing to `stable` runs `.github/workflows/deploy.yml`: CI checks, then `npx convex deploy` (pushes schema and functions to the production deployment), then a static build of the frontend pointed at that deployment, published to `https://ucsb-cssa-dev.github.io/canvas/`.

One-time setup:

1. **GitHub Pages:** repo Settings > Pages > Source: **GitHub Actions**.
2. **Secret `CONVEX_DEPLOY_KEY`:** Convex dashboard > production deployment > Settings > Deploy keys > generate a production key, then add it under repo Settings > Secrets and variables > Actions.
3. **Production Convex environment variables** (`npx convex env set --prod ...` from `backend/`, or the dashboard): `SITE_URL=https://ucsb-cssa-dev.github.io/canvas` (include the base path, no trailing slash), `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `JWT_PRIVATE_KEY` and `JWKS` (run `npx @convex-dev/auth --prod`), `BOOTSTRAP_ADMIN_EMAIL`, the push notification keys `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (generate a pair with `npx web-push generate-vapid-keys` in `backend/`; use a different pair than dev), and for 小飒 `AI_API_KEY` (`npm run ai:env --workspace backend -- --prod` copies it from the root `.env`).
4. **Google OAuth:** add the production `https://<prod-deployment>.convex.site/api/auth/callback/google` redirect URI.

The base path (`/canvas`) comes from `actions/configure-pages`, so it follows the repository name, and is empty if a custom domain is configured.
