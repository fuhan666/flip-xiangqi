// 历史存储与动作耗时微基准 worker：只保留最新 state，计时区外做 GC 与快照统计。
// 用法（由父驱动 spawn）：node --expose-gc --max-old-space-size=2048 worker.mjs --root <dir> --steps 100
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    result[argv[i].replace(/^--/, '')] = argv[i + 1];
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const root = resolve(args.root ?? '.');
const steps = Number(args.steps ?? 100);
const warmupSteps = Number(args.warmup ?? 20);

if (!Number.isSafeInteger(steps) || steps <= 0) {
  throw new Error(`invalid --steps: ${args.steps}`);
}

const game = await import(pathToFileURL(join(root, 'src/game/index.ts')).href);

/** 32 枚全部明置的标准开局；双方马 (1,9)/(1,0) 四步往返，全程无吃子、无终局。 */
function buildPosition() {
  const pieces = [];
  const add = (camp, type, x, y) => {
    pieces.push({ id: `${camp}-${type}-${x}-${y}`, camp, type, position: { x, y }, revealed: true, captured: false });
  };
  for (const camp of ['black', 'red']) {
    const back = camp === 'black' ? 0 : 9;
    const pawn = camp === 'black' ? 3 : 6;
    const cannon = camp === 'black' ? 2 : 7;
    add(camp, 'king', 4, back);
    add(camp, 'advisor', 3, back);
    add(camp, 'advisor', 5, back);
    add(camp, 'elephant', 2, back);
    add(camp, 'elephant', 6, back);
    add(camp, 'horse', 1, back);
    add(camp, 'horse', 7, back);
    add(camp, 'rook', 0, back);
    add(camp, 'rook', 8, back);
    add(camp, 'cannon', 1, cannon);
    add(camp, 'cannon', 7, cannon);
    for (const x of [0, 2, 4, 6, 8]) add(camp, 'pawn', x, pawn);
  }
  return game.createEmptyGameState({ pieces });
}

const cycle = [
  { type: 'move', from: { x: 1, y: 9 }, to: { x: 2, y: 7 } },
  { type: 'move', from: { x: 1, y: 0 }, to: { x: 2, y: 2 } },
  { type: 'move', from: { x: 2, y: 7 }, to: { x: 1, y: 9 } },
  { type: 'move', from: { x: 2, y: 2 }, to: { x: 1, y: 0 } },
];

function collectGarbage() {
  if (typeof global.gc === 'function') {
    global.gc();
    global.gc();
  }
}

function applyStep(state, index) {
  const next = game.applyAction(state, cycle[index % cycle.length]);
  if (next.lastError) {
    throw new Error(`step ${index + 1} failed: ${next.lastError}`);
  }
  return next;
}

// 独立短局预热后释放，避免 JIT/模块初始化落入采样。
let warm = buildPosition();
for (let i = 0; i < warmupSteps; i += 1) warm = applyStep(warm, i);
warm = null;
collectGarbage();

let state = buildPosition();
const durations = new Float64Array(steps);
collectGarbage();
const heapStartBytes = process.memoryUsage().heapUsed;

const startedAt = performance.now();
for (let i = 0; i < steps; i += 1) {
  const stepStartedAt = performance.now();
  state = applyStep(state, i);
  durations[i] = performance.now() - stepStartedAt;
  if ((i + 1) % 50 === 0) process.stderr.write(`PROGRESS ${i + 1}\n`);
}
const totalMs = performance.now() - startedAt;

collectGarbage();
const heapEndBytes = process.memoryUsage().heapUsed;

const sorted = Array.from(durations).sort((a, b) => a - b);
const tail = Array.from(durations.slice(Math.max(0, steps - Math.min(100, steps)))).sort((a, b) => a - b);
function percentile(values, p) {
  if (values.length === 0) return null;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil((p / 100) * values.length) - 1));
  return values[index];
}

// 计时区外统计保留的历史/撤销存储字节，直观展示平方级与线性差异。
const historyJSONBytes = JSON.stringify({ actionHistory: state.actionHistory, undoStack: state.undoStack }).length;

process.stdout.write(`${JSON.stringify({
  steps,
  completedSteps: steps,
  heapStartBytes,
  heapEndBytes,
  heapDeltaBytes: heapEndBytes - heapStartBytes,
  historyJSONBytes,
  historyLength: state.actionHistory.length,
  undoLength: state.undoStack.length,
  totalMs,
  meanMs: totalMs / steps,
  p50Ms: percentile(sorted, 50),
  p95Ms: percentile(sorted, 95),
  tailSteps: tail.length,
  tailP50Ms: percentile(tail, 50),
  tailP95Ms: percentile(tail, 95),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
})}\n`);
