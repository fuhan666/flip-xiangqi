// 历史存储与动作耗时基准驱动：对指定源码目录逐档启动独立 Node 子进程采样。
// 例：node scripts/benchmark-history.mjs --source-root . --label after --steps 100,200,400,1000 --repeats 3 --output history-after.json
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const [name, inline] = token.slice(2).split('=');
    result[name] = inline ?? argv[++i];
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const sourceRoot = resolve(repoRoot, args['source-root'] ?? '.');
const label = args.label ?? 'sample';
const stepsList = String(args.steps ?? '100,200,400,1000')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isSafeInteger(value) && value > 0);
const repeats = Number(args.repeats ?? 3);
const heapMb = Number(args['heap-mb'] ?? 2048);
const timeoutMs = Number(args['timeout-ms'] ?? 120_000);
const outputPath = args.output ? resolve(repoRoot, args.output) : null;
const workerPath = join(scriptDir, 'benchmark-history-worker.mjs');

if (!existsSync(join(sourceRoot, 'src/game/index.ts'))) {
  throw new Error(`source root has no src/game/index.ts: ${sourceRoot}`);
}
if (stepsList.length === 0) throw new Error('no valid --steps');

function runPoint(steps) {
  return new Promise((settle) => {
    const startedAt = Date.now();
    const child = spawn(
      process.execPath,
      [
        '--expose-gc',
        `--max-old-space-size=${heapMb}`,
        '--import',
        'tsx',
        workerPath,
        '--root',
        sourceRoot,
        '--steps',
        String(steps),
      ],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    let completedSteps = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      for (const match of text.matchAll(/PROGRESS (\d+)/g)) completedSteps = Number(match[1]);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const elapsedMs = Date.now() - startedAt;
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
      if (!timedOut && code === 0 && lastLine) {
        try {
          settle({ ok: true, steps, ...JSON.parse(lastLine), elapsedMs });
          return;
        } catch {
          // fall through to failure record
        }
      }
      settle({
        ok: false,
        steps,
        targetSteps: steps,
        completedSteps,
        timedOut,
        exitCode: code,
        signal,
        elapsedMs,
        resourceLimit: `--max-old-space-size=${heapMb} --timeout-ms=${timeoutMs}`,
        stderrTail: stderr.slice(-400),
      });
    });
  });
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

const results = [];
for (const steps of stepsList) {
  const runs = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const result = await runPoint(steps);
    runs.push(result);
    process.stdout.write(
      `${label} ${steps} steps repeat ${repeat + 1}/${repeats}: ${
        result.ok ? `${result.totalMs.toFixed(1)}ms, heap ${(result.heapDeltaBytes / 1048576).toFixed(2)}MiB` : 'INCOMPLETE'
      }\n`,
    );
  }
  const completed = runs.filter((run) => run.ok);
  const primary = completed[0] ?? runs[0];
  results.push({
    steps,
    runs,
    median: completed.length > 0
      ? {
          totalMs: median(completed.map((run) => run.totalMs)),
          meanMs: median(completed.map((run) => run.meanMs)),
          p50Ms: median(completed.map((run) => run.p50Ms)),
          p95Ms: median(completed.map((run) => run.p95Ms)),
          tailP50Ms: median(completed.map((run) => run.tailP50Ms)),
          tailP95Ms: median(completed.map((run) => run.tailP95Ms)),
          heapStartBytes: median(completed.map((run) => run.heapStartBytes)),
          heapEndBytes: median(completed.map((run) => run.heapEndBytes)),
          heapDeltaBytes: median(completed.map((run) => run.heapDeltaBytes)),
          historyJSONBytes: median(completed.map((run) => run.historyJSONBytes)),
        }
      : null,
    note: primary.ok
      ? null
      : `未完成：目标 ${primary.targetSteps} 步，实际 ${primary.completedSteps} 步，${primary.timedOut ? '超时' : `退出码 ${primary.exitCode}/信号 ${primary.signal}`}，elapsed ${primary.elapsedMs}ms，资源上限 ${primary.resourceLimit}`,
  });
}

const report = {
  label,
  sourceRoot,
  steps: stepsList,
  repeats,
  heapMb,
  timeoutMs,
  capturedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model ?? 'unknown',
    cpuCount: cpus().length,
    totalMemBytes: totalmem(),
  },
  results,
};

if (outputPath) {
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`wrote ${outputPath}\n`);
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
