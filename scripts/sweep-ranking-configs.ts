/** Parallel one-factor ranking sweep using cached CodeSearchNet embeddings. */
const COMMON_ENV = {
  MIRU_CALIBRATION_PER_LANGUAGE: "100",
};

const configs: Array<{ name: string; env: Record<string, string> }> = [
  { name: "baseline-alpha-035", env: { MIRU_CALIBRATION_ALPHAS: "0.35" } },
  { name: "alpha-025", env: { MIRU_CALIBRATION_ALPHAS: "0.25" } },
  { name: "alpha-045", env: { MIRU_CALIBRATION_ALPHAS: "0.45" } },
  {
    name: "candidate-10",
    env: { MIRU_CALIBRATION_ALPHAS: "0.35", MIRU_RANK_CANDIDATE_MULTIPLIER: "10" },
  },
  { name: "rrf-20", env: { MIRU_CALIBRATION_ALPHAS: "0.35", MIRU_RANK_RRF_K: "20" } },
  { name: "rrf-120", env: { MIRU_CALIBRATION_ALPHAS: "0.35", MIRU_RANK_RRF_K: "120" } },
  {
    name: "coherence-0",
    env: { MIRU_CALIBRATION_ALPHAS: "0.35", MIRU_RANK_FILE_COHERENCE_BOOST: "0" },
  },
  {
    name: "exact-stem-0",
    env: { MIRU_CALIBRATION_ALPHAS: "0.35", MIRU_RANK_EXACT_STEM_BOOST: "0" },
  },
  {
    name: "definition-0",
    env: { MIRU_CALIBRATION_ALPHAS: "0.35", MIRU_RANK_DEFINITION_BOOST: "0" },
  },
  {
    name: "path-penalties-off",
    env: { MIRU_CALIBRATION_ALPHAS: "0.35", MIRU_RANK_PATH_PENALTIES: "0" },
  },
  {
    name: "saturation-080",
    env: { MIRU_CALIBRATION_ALPHAS: "0.35", MIRU_RANK_FILE_SATURATION_DECAY: "0.8" },
  },
];

async function runOne(config: (typeof configs)[number]) {
  const proc = Bun.spawn(["bun", "run", "scripts/calibrate-codesearchnet-alpha.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, ...COMMON_ENV, ...config.env },
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
  return { name: config.name, env: config.env, result: payload.results[0] };
}

const output: Awaited<ReturnType<typeof runOne>>[] = [];
let next = 0;
const workers = Array.from({ length: Math.min(4, configs.length) }, async () => {
  while (true) {
    const config = configs[next++];
    if (!config) return;
    console.error(`Starting ${config.name}`);
    output.push(await runOne(config));
  }
});
await Promise.all(workers);
output.sort(
  (a, b) => Number((b.result as { mrr: number }).mrr) - Number((a.result as { mrr: number }).mrr),
);
console.error(
  output
    .map(({ name, result }) => {
      const row = result as { exact_match_at_1: number; hit_at_3: number; mrr: number };
      return `${name}  top1=${(row.exact_match_at_1 * 100).toFixed(1)}% hit3=${(row.hit_at_3 * 100).toFixed(1)}% mrr=${row.mrr.toFixed(3)}`;
    })
    .join("\n"),
);
console.log(JSON.stringify({ calibration_examples: 600, configs: output }, null, 2));
