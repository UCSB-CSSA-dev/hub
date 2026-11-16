import { internalMutation } from "./_generated/server";
import { ensureSeed } from "./lib/departments";

/** Runs automatically on the first sign-in; can also be run from the Convex dashboard. */
export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ensureSeed(ctx);
  },
});
