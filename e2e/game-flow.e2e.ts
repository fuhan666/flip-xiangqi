import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import path from 'node:path';

const EVIDENCE_DIR = path.resolve(process.cwd(), '../evidence');

/**
 * Deterministic full-game replay against the production build.
 *
 * The opening shuffle is driven by an injected seeded RNG (same LCG as the
 * engine unit tests), so every click sequence and expected value below is a
 * fixed constant derived from that opening — never computed through the
 * engine under test while asserting.
 *
 * The react/react-dom production bundles consume exactly two `Math.random()`
 * values at module init (property-name seeds). Those two preamble values are
 * discarded so the seeded stream stays aligned with `createSeededRng` in the
 * engine unit tests.
 */
const SEED = 2;

const SEEDED_RNG = `(() => {
  let state = ${SEED} >>> 0;
  const lcg = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  let preambleCalls = 2;
  Math.random = () => {
    if (preambleCalls > 0) {
      preambleCalls -= 1;
      return 0.5;
    }
    return lcg();
  };
})();`;

function watchPageHealth(page: Page): { consoleErrors: string[]; resourceFailures: string[] } {
  const consoleErrors: string[] = [];
  const resourceFailures: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  page.on('requestfailed', (request) => {
    if (request.url().includes('/assets/') || request.resourceType() === 'document') {
      resourceFailures.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`);
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && (response.url().includes('/assets/') || response.request().resourceType() === 'document')) {
      resourceFailures.push(`${response.status()} ${response.url()}`);
    }
  });
  return { consoleErrors, resourceFailures };
}

async function expectOpeningCounts(page: Page): Promise<void> {
  const counts = await page.evaluate(() => ({
    hidden: document.querySelectorAll('.cell[data-cell-state="hidden"]').length,
    revealed: document.querySelectorAll('.cell[data-cell-state="revealed"]').length,
    empty: document.querySelectorAll('.cell[data-cell-state="empty"]').length,
  }));
  expect(counts).toEqual({ hidden: 30, revealed: 2, empty: 58 });
}

async function flipHiddenCell(page: Page, x: number, y: number, glyph: string): Promise<void> {
  const cell = page.getByTestId(`cell-${x}-${y}`);
  await cell.click();
  await expect(cell).toHaveAttribute('data-flip-phase', 'none');
  await expect(cell).toHaveAttribute('data-cell-state', 'revealed');
  await expect(cell.locator('.piece-text')).toHaveText(glyph);
}

async function selectAndMove(page: Page, from: [number, number], to: [number, number], glyph: string): Promise<void> {
  const fromCell = page.getByTestId(`cell-${from[0]}-${from[1]}`);
  const toCell = page.getByTestId(`cell-${to[0]}-${to[1]}`);
  await fromCell.click();
  await expect(fromCell).toHaveAttribute('aria-pressed', 'true');
  await toCell.click();
  await expect(toCell.locator('.piece-text')).toHaveText(glyph);
  await expect(fromCell).toHaveAttribute('data-cell-state', 'empty');
}

async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ fullPage: true, path: path.join(EVIDENCE_DIR, `game-flow-${name}.png`) });
}

test.describe('seeded full game flow', () => {
  test('replays opening -> flip -> move -> blocked -> capture -> cannon capture -> checkmate -> restart', async ({ page }) => {
    const health = watchPageHealth(page);
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.addInitScript(SEEDED_RNG);
    await page.goto('/');

    const turnIndicator = page.locator('.board-turn-value');
    const turnValue = page.locator('.status-item-turn .status-value');
    const historyPanel = page.locator('.move-history-panel');

    // --- Opening: both kings revealed, 30 hidden pieces on the fixed square set.
    await expect(turnIndicator).toHaveText('红方回合');
    await expect(turnValue).toHaveText('红方');
    await expectOpeningCounts(page);
    await expect(page.getByTestId('cell-7-2')).toHaveAttribute('data-cell-state', 'hidden');
    await expect(page.getByTestId('cell-4-0').locator('.piece-text')).toHaveText('将');
    await expect(page.getByTestId('cell-4-9').locator('.piece-text')).toHaveText('帅');
    await screenshot(page, '01-opening');

    // --- Phase 1: flip a hidden piece (reveals the seeded red rook at 7,2).
    await flipHiddenCell(page, 7, 2, '俥');
    await expect(page.getByTestId('cell-7-2')).toHaveAttribute('data-recent-action', 'flip');
    await expect(turnIndicator).toHaveText('黑方回合');
    await expect(historyPanel.locator('.move-history-turn')).toHaveText('第 1 手');
    await expect(historyPanel.locator('.move-history-summary')).toHaveText('红方翻开了红方俥');
    await screenshot(page, '02-flip');

    // Black flips the hidden black advisor at 2,3.
    await flipHiddenCell(page, 2, 3, '士');

    // --- Phase 2: move the own revealed rook 7,2 -> 5,2.
    await selectAndMove(page, [7, 2], [5, 2], '俥');
    await expect(page.getByTestId('cell-7-2')).toHaveAttribute('data-recent-action', 'move-from');
    await expect(page.getByTestId('cell-5-2')).toHaveAttribute('data-recent-action', 'move-to');
    await expect(turnIndicator).toHaveText('黑方回合');
    await expect(historyPanel.locator('.move-history-turn')).toHaveText('第 3 手');
    await expect(historyPanel.locator('.move-history-summary')).toHaveText('红方移动红方俥');

    // Black flips the hidden red horse at 1,0.
    await flipHiddenCell(page, 1, 0, '傌');

    // --- Phase 3: blocked / illegal action keeps the state intact.
    const rookCell = page.getByTestId('cell-5-2');
    await rookCell.click();
    await expect(rookCell).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('cell-0-2').click();
    await expect(page.locator('.error')).toHaveText('非法操作：路径被阻挡');
    await expect(turnValue).toHaveText('红方');
    await expect(rookCell.locator('.piece-text')).toHaveText('俥');
    await expect(historyPanel.locator('.move-history-turn')).toHaveText('第 4 手');
    await screenshot(page, '03-blocked-illegal');

    // Red flips the hidden red rook at 7,7; black flips the red elephant at 7,0.
    await flipHiddenCell(page, 7, 7, '俥');
    await flipHiddenCell(page, 7, 0, '相');
    await selectAndMove(page, [7, 7], [7, 4], '俥');
    await flipHiddenCell(page, 8, 0, '兵');
    await selectAndMove(page, [7, 4], [2, 4], '俥');
    await flipHiddenCell(page, 0, 0, '炮');

    // --- Phase 4: capture the revealed black advisor with the rook.
    await selectAndMove(page, [2, 4], [2, 3], '俥');
    await expect(page.getByTestId('cell-2-3')).toHaveAttribute('data-recent-action', 'capture');
    await expect(page.getByText('刚刚吃子', { exact: true })).toBeVisible();
    await expect(page.getByText('黑方阵亡：士', { exact: true })).toBeVisible();
    await expect(historyPanel.locator('.move-history-turn')).toHaveText('第 11 手');
    await expect(historyPanel.locator('.move-history-consequence').first()).toHaveText('结果：吃掉黑方士');
    await screenshot(page, '04-capture');

    await flipHiddenCell(page, 8, 6, '仕');
    await selectAndMove(page, [2, 3], [2, 4], '俥');
    await flipHiddenCell(page, 0, 3, '兵');
    await selectAndMove(page, [2, 4], [6, 4], '俥');
    await flipHiddenCell(page, 2, 9, '兵');
    await flipHiddenCell(page, 3, 9, '炮');
    await flipHiddenCell(page, 4, 6, '仕');
    await selectAndMove(page, [3, 9], [3, 5], '炮');
    await flipHiddenCell(page, 6, 3, '象');
    await selectAndMove(page, [3, 5], [6, 5], '炮');
    await flipHiddenCell(page, 2, 6, '兵');

    // --- Phase 5: cannon captures over exactly one screen (rook at 6,4).
    await selectAndMove(page, [6, 5], [6, 3], '炮');
    await expect(page.getByTestId('cell-6-4').locator('.piece-text')).toHaveText('俥');
    await expect(page.getByText('黑方阵亡：士 象', { exact: true })).toBeVisible();
    await expect(historyPanel.locator('.move-history-turn')).toHaveText('第 23 手');
    await expect(historyPanel.locator('.move-history-consequence').first()).toHaveText('结果：吃掉黑方象');
    await screenshot(page, '05-cannon-capture');

    await flipHiddenCell(page, 8, 9, '傌');

    // --- Phase 6: real checkmate with the rook lift 5,2 -> 4,2.
    await selectAndMove(page, [5, 2], [4, 2], '俥');

    await expect(page.getByTestId('cell-4-2').locator('.piece-text')).toHaveText('俥');
    await expect(page.getByTestId('cell-4-0').locator('.piece-text')).toHaveText('将');
    await expect(turnIndicator).toHaveText('终局已定');
    await expect(turnValue).toHaveText('对局结束');
    await expect(page.getByText('红方将死对手，获得胜利', { exact: true })).toBeVisible();
    await expect(page.getByText('黑方被将军', { exact: true })).toBeVisible();
    await expect(page.getByText('红方胜利', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: '本局结果' })).toBeVisible();
    await expect(page.getByText('结束方式', { exact: true })).toBeVisible();
    await expect(page.getByText('将死获胜', { exact: true })).toBeVisible();
    await expect(historyPanel.locator('.move-history-turn')).toHaveText('第 25 手');
    await expect(historyPanel.locator('.move-history-consequence').last()).toHaveText('结果：红方胜利（将死）');
    await expect(page.getByText('刚刚完成制胜一手', { exact: true })).toBeVisible();
    await screenshot(page, '06-checkmate');

    // No new turn after the game is over: the flip attempt is rejected.
    await page.getByTestId('cell-0-6').click();
    await expect(page.locator('.error')).toHaveText('非法操作：对局已经结束，请重新开局');
    await expect(turnValue).toHaveText('对局结束');
    await expect(historyPanel.locator('.move-history-turn')).toHaveText('第 25 手');

    // --- Phase 7: restart archives the result and starts a fresh opening.
    await page.getByRole('button', { name: '再来一局' }).click();
    await expect(turnIndicator).toHaveText('红方回合');
    await expect(turnValue).toHaveText('红方');
    await expectOpeningCounts(page);
    await expect(page.getByText('红方获胜（将死获胜）', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { level: 3, name: '本局结果' })).toHaveCount(0);
    await screenshot(page, '07-restart');

    expect(health.consoleErrors).toEqual([]);
    expect(health.resourceFailures).toEqual([]);
  });

  test('seeded opening is identical across page loads', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.addInitScript(SEEDED_RNG);

    await page.goto('/');
    await expectOpeningCounts(page);
    await flipHiddenCell(page, 7, 2, '俥');

    await page.reload();
    await expectOpeningCounts(page);
    await expect(page.getByTestId('cell-7-2')).toHaveAttribute('data-cell-state', 'hidden');
    await flipHiddenCell(page, 7, 2, '俥');
    await expect(page.getByTestId('cell-4-3')).toHaveAttribute('data-cell-state', 'hidden');
  });
});
