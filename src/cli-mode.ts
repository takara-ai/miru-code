/** Keep older stdio MCP configs working when they launch Miru without a subcommand. */
export function shouldRunMcp(
  argv: readonly string[],
  stdinIsTTY: boolean,
  stdoutIsTTY: boolean,
): boolean {
  if (argv[0] === "mcp") return argv[1] !== "-h" && argv[1] !== "--help";
  if (stdinIsTTY || stdoutIsTTY) return false;
  const first = argv[0];
  return (
    first === undefined ||
    first === "--benchmark" ||
    first === "--benchmark=true" ||
    first === "--benchmark=false" ||
    first === "--ref" ||
    first === "--content"
  );
}
