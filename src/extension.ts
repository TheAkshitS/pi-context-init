// Thin Pi adapter. The ONLY module that touches Pi APIs, using only the
// signatures verified in docs/pi-api-notes.md against Pi 0.85.1:
//   pi.registerCommand(name, options)
//   ctx.cwd, ctx.hasUI, ctx.ui.notify/select
// Structural local types mirror the verified Pi shapes so the deterministic
// core stays Pi-free and unit-testable outside Pi. No `editor` use in the
// baseline: with no verified read-only viewer, Copy/print goes through
// show(); Apply/Cancel through select(). UI closure, timeout, or unknown
// input resolves to no write.
import { CHOICES, runInit, type Choice, type InteractionPort } from "./command.js";

export const MIN_PI_VERSION_NOTE =
  "pi-init requires pi >= 0.85.1 with extension command support (pi.registerCommand). Update pi, then reinstall.";

interface PiUI {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  select(title: string, options: string[]): Promise<string | undefined>;
}

interface PiCommandContext {
  cwd: string;
  hasUI: boolean;
  ui: PiUI;
}

interface PiApi {
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: PiCommandContext) => Promise<void>;
    },
  ): void;
}

function toInteraction(ctx: PiCommandContext): InteractionPort {
  return {
    show: async (text: string): Promise<void> => {
      try {
        ctx.ui.notify(text, "info");
      } catch {
        // Notification is best-effort; the decision prompt still gates writes.
      }
    },
    choose: async (title: string, options: readonly Choice[]): Promise<Choice | undefined> => {
      let picked: string | undefined;

      try {
        picked = await ctx.ui.select(
          title,
          options.map((o) => o.label),
        );
      } catch {
        return undefined;
      }

      return options.find((o) => o.label === picked);
    },
  };
}

export async function handleInit(
  args: string,
  ctx: PiCommandContext,
  piNotify?: (text: string) => void,
): Promise<string> {
  const ui = toInteraction(ctx);
  const arg = args.trim();

  if (!ctx.hasUI) {
    const result = await runInit(ctx.cwd, args, { show: ui.show, choose: async () => undefined });

    const suffix =
      arg === "audit" || arg === "status"
        ? " Interactive UI is unavailable; rerun /init in the TUI to see the full report."
        : " Interactive UI is unavailable; rerun /init in the TUI to apply.";

    const message = `${result.message}${suffix}`;

    try {
      ctx.ui.notify(message, result.wrote ? "info" : "warning");
    } catch {
      piNotify?.(message);
    }

    return message;
  }

  const result = await runInit(ctx.cwd, args, ui);

  if (result.message) {
    try {
      ctx.ui.notify(result.message, result.wrote ? "info" : "warning");
    } catch {
      // Result already returned to the caller; notification is best-effort.
    }
  }

  return result.message;
}

export default function initExtension(pi: PiApi): void {
  if (!pi || !(pi.registerCommand instanceof Function)) {
    throw new Error(MIN_PI_VERSION_NOTE);
  }

  pi.registerCommand("init", {
    description: "Inspect the repo, draft concise instructions, and apply on explicit approval.",
    handler: async (args: string, ctx: PiCommandContext): Promise<void> => {
      const startDir = ctx?.cwd ?? process.cwd();
      await handleInit(args, { ...ctx, cwd: startDir });
    },
  });
}

// Re-exported for tests: the baseline choice labels the adapter presents.
export { CHOICES };
