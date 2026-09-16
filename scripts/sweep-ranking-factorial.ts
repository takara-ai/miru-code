/** Second-stage parallel factorial sweep around the best first-stage ranking settings. */
const alphas = [0.2, 0.25, 0.3, 0.35];
const rrfKs = [10, 20, 30];
const candidates = [3, 5];

const configs = alphas.flatMap((alpha) =>
  rrfKs.flatMap((rrfK) =>
    candidates.map((candidateMultiplier) => ({
      name: `a${alpha}-rrf${rrfK}-cand${candidateMultiplier}`,
      env: {
        MIRU_CALIBRATION_PER_LANGUAGE: "100",
        MIRU_CALIBRATION_ALPHAS: String(alpha),
        MIRU_RANK_RRF_K: String(rrfK),
        MIRU_RANK_CANDIDATE_MULTIPLIER: String(candidateMultiplier),
        MIRU_RANK_FILE_COHERENCE_BOOST: "0",
      },
    })),
  ),
);

async function runOne(config: (typeof configs)[number]) {
  const proc = Bun.spawn(["bun", "run", "scripts/calibrate-codesearchnet-alpha.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, ...config.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${config.name}: ${stderr}`);
  const payload = JSON.parse(stdout) as { results: Array<Record<string, unknown>> };
  return { ...config, result: payload.results[0] };
}

const output: Awaited<ReturnType<typeof runOne>>[] = [];
let next = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (true) {
      const config = configs[next++];
      if (!config) return;
      console.error(`Starting ${config.name}`);
      output.push(await runOne(config));
    }
  }),
);

output.sort(
  (a, b) => Number((b.result as { mrr: number }).mrr) - Number((a.result as { mrr: number }).mrr),
);
console.error(
  output
    .slice(0, 8)
    .map(({ name, result }) => {
      const row = result as { exact_match_at_1: number; hit_at_3: number; mrr: number };
      return `${name}  top1=${(row.exact_match_at_1 * 100).toFixed(1)}% hit3=${(row.hit_at_3 * 100).toFixed(1)}% mrr=${row.mrr.toFixed(3)}`;
    })
    .join("\n"),
);
console.log(JSON.stringify({ calibration_examples: 600, configs: output }, null, 2));
