// Copies the AI_* settings from the repo-root .env (gitignored) into Convex environment variables,
// where the backend reads them. Values are never printed, and go to the CLI through stdin so they
// don't show up in the process list or shell history.
//
//   npm run ai:env --workspace backend            # dev deployment
//   npm run ai:env --workspace backend -- --prod  # production deployment
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const KEYS = ["AI_API_KEY", "AI_BASE_URL", "AI_MODEL_FAST", "AI_MODEL_ANSWER", "AI_DRY_RUN"];
const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = resolve(backendDir, "..", ".env");

if (!existsSync(envPath)) {
  console.error(`No .env at ${envPath}. Add AI_API_KEY=... there first.`);
  process.exit(1);
}

const values = {};
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (!match || !KEYS.includes(match[1])) continue;
  values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
}

const found = KEYS.filter((key) => values[key]);
if (!found.includes("AI_API_KEY") && values.AI_DRY_RUN !== "true") {
  console.error("AI_API_KEY is missing from .env.");
  process.exit(1);
}

const extra = process.argv.slice(2).filter((arg) => arg === "--prod");
for (const key of found) {
  const result = spawnSync("npx", ["convex", "env", "set", ...extra, key], {
    cwd: backendDir,
    input: values[key],
    stdio: ["pipe", "ignore", "inherit"],
  });
  if (result.status !== 0) {
    console.error(`Failed to set ${key}.`);
    process.exit(result.status ?? 1);
  }
  console.log(`Set ${key}${extra.length ? " (prod)" : ""}.`);
}
