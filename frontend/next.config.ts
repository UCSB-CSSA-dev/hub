import { readFileSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// GitHub Pages serves the site from /<repo>, e.g. /hub. Leave empty for local dev.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** Local dev fallback: the URL `npx convex dev` wrote to backend/.env.local. */
function localConvexUrl(): string | undefined {
  try {
    const env = readFileSync(path.join(__dirname, "../backend/.env.local"), "utf8");
    return env.match(/^CONVEX_URL=(.+)$/m)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  basePath: basePath || undefined,
  images: { unoptimized: true },
  transpilePackages: ["@cssa-hub/backend"],
  env: {
    NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL || localConvexUrl() || "",
  },
  turbopack: {
    root: path.join(__dirname, ".."),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
