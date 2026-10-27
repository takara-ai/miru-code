import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentTarget, InstallMode } from "./agents.ts";

/** A separate owned hook file; never merges into or replaces the user's hooks. */
export async function applyCopilotRouting(agent: AgentTarget, mode: InstallMode): Promise<void> {
  if (agent.id !== "copilot" || !agent.instructionsPath || !agent.mcp) return;
  const home = dirname(agent.instructionsPath);
  const assets = join(home, "miru-routing");
  const hooks = join(home, "hooks", "miru-routing.json");
  if (mode === "uninstall") {
    await rm(hooks, { force: true });
    await rm(assets, { recursive: true, force: true });
    return;
  }
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "../copilot/routing-guard.ts")],
    target: "bun",
  });
  if (!build.success || !build.outputs[0])
    throw new Error(`Cannot build Copilot routing helper: ${build.logs.join("\n")}`);
  await mkdir(assets, { recursive: true, mode: 0o700 });
  await mkdir(dirname(hooks), { recursive: true });
  const script = join(assets, "guard.js");
  await Bun.write(script, await build.outputs[0].text());
  await Bun.write(
    hooks,
    `${JSON.stringify(
      {
        version: 1,
        hooks: Object.fromEntries(
          [
            ["sessionStart", "start"],
            ["preToolUse", "pre"],
            ["postToolUse", "post"],
            ["sessionEnd", "end"],
          ].map(([event, phase]) => [
            event,
            [
              {
                type: "command",
                exec: process.execPath,
                args: [script, phase, agent.mcp?.path],
                timeoutSec: 10,
              },
            ],
          ]),
        ),
      },
      null,
      2,
    )}\n`,
  );
}
