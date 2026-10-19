import { expect, test, type BrowserContext, type ConsoleMessage, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Real two-player online checkmate regression.
 *
 * The whole match is played by two real browser contexts against the
 * server-authoritative room runtime (TEST_ROOM_SEED=42) purely through visible
 * UI actions — flips, moves, undo negotiation, draw negotiation, reconnection —
 * and ends with a genuine checkmate produced by the engine. No WebSocket
 * message is ever injected or forged to fake a terminal state.
 *
 * The opening layout is the deterministic seed-42 shuffle; the mating line is a
 * fixed legal sequence derived from that layout:
 *   1. red flips (2,3) -> red rook 俥
 *   2. black flips (0,3) -> black pawn 卒
 *   3. red lifts the rook (2,3) -> (2,2)   [later rolled back and replayed]
 *   4. black flips (8,6) -> black pawn 卒
 *   5. red rook (2,2) -> (4,2) delivers checkmate on the black king at (4,0):
 *      the escape squares (3,0)/(5,0) stay blocked by dark pieces, (4,1) is
 *      covered by the rook, and black has no revealed piece able to capture the
 *      rook or interpose.
 */

const EVIDENCE_DIR = path.resolve(process.cwd(), '../evidence');
if (!fs.existsSync(EVIDENCE_DIR)) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

// 全链路回归包含协商倒计时与断线重连等待，放宽单测时长上限。
test.describe.configure({ timeout: 240_000 });

interface RoomHandle {
  address: string;
  port: number;
}

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}

async function captureEvidence(page: Page, filename: string): Promise<void> {
  await page.screenshot({ fullPage: false, path: path.join(EVIDENCE_DIR, filename) });
}

async function installWebSocketSpy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    (window as any).__wsMessages = [];
    (window as any).__lastGameState = null;
    (window as any).__lastWelcome = null;

    window.WebSocket = class extends OrigWS {
      constructor(...args: any[]) {
        super(...(args as [string, ...any[]]));
        (window as any).__roomWs = this;

        this.addEventListener('message', (event) => {
          try {
            const data = JSON.parse(event.data);
            (window as any).__wsMessages.push(data);
            if (data.type === 'game.state') {
              (window as any).__lastGameState = data;
            }
            if (data.type === 'welcome') {
              (window as any).__lastWelcome = data;
            }
          } catch {}
        });
      }
    };
  });
}

async function teardownMatch(hostPage: Page): Promise<void> {
  try {
    const returnLobbyBtn = hostPage.getByTestId('btn-return-lobby');
    if (await returnLobbyBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await returnLobbyBtn.click({ force: true }).catch(() => {});
      await hostPage.waitForTimeout(500);
    }
    const closeRoomBtn = hostPage.getByTestId('close-room');
    if (await closeRoomBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await closeRoomBtn.click({ force: true }).catch(() => {});
      const confirmYes = hostPage.getByTestId('confirm-yes');
      if (await confirmYes.isVisible({ timeout: 1000 }).catch(() => false)) {
        await confirmYes.click({ force: true }).catch(() => {});
        await hostPage.waitForTimeout(600);
      }
    }
  } catch {
    // 清理阶段异常可忽略
  }
}

async function createRoom(page: Page): Promise<RoomHandle> {
  await installWebSocketSpy(page);
  await page.goto('/');

  // 清理可能残留的旧房间/对局界面
  await teardownMatch(page);
  await page.goto('/');

  await page.getByTestId('menu-create').click();
  const addressElement = page.getByTestId('room-address-main');
  await expect(addressElement).toBeVisible({ timeout: 10_000 });
  const address = ((await addressElement.textContent()) ?? '').trim();
  expect(address).toMatch(/^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/);
  const port = Number(address.split(':').pop());
  await expect(page.getByTestId('lobby-ready-toggle')).toBeVisible({ timeout: 10_000 });
  return { address, port };
}

async function openGuest(context: BrowserContext, port: number): Promise<Page> {
  const page = await context.newPage();
  await installWebSocketSpy(page);
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByTestId('menu-join').click();
  return page;
}

async function joinRoom(page: Page, address: string): Promise<void> {
  await page.getByTestId('join-address-input').fill(address);
  await page.getByTestId('join-submit').click();
  await expect(page.getByTestId('lobby-ready-toggle')).toBeVisible({ timeout: 10_000 });
}

async function startStandardMatch(hostPage: Page, guestPage: Page): Promise<void> {
  await hostPage.getByTestId('setting-side-host-red').click({ force: true });
  await guestPage.getByTestId('lobby-ready-toggle').click();
  await expect(guestPage.getByTestId('lobby-ready-toggle')).toHaveText('取消准备', { timeout: 10_000 });
  await hostPage.getByTestId('lobby-ready-toggle').click();
  await expect(hostPage.getByTestId('lobby-start-hint')).toContainText('双方已就绪', { timeout: 10_000 });
  await hostPage.getByTestId('lobby-start').click();

  await expect(hostPage.getByTestId('online-game')).toBeVisible({ timeout: 10_000 });
  await expect(guestPage.getByTestId('online-game')).toBeVisible({ timeout: 10_000 });
  await expect(hostPage.getByTestId('shuffling-banner')).toHaveCount(0, { timeout: 2000 });
  await expect(guestPage.getByTestId('shuffling-banner')).toHaveCount(0, { timeout: 2000 });
}

async function expectStep(page: Page, step: number): Promise<void> {
  await expect(page.getByTestId('step-number')).toHaveText(`第 ${step} 步`, { timeout: 5000 });
}

async function getBoardGrid(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const cells: string[] = [];
    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 9; x += 1) {
        const el = document.querySelector(`[data-testid="cell-${x}-${y}"] .piece-text`);
        cells.push((el?.textContent ?? '').trim());
      }
    }
    return cells;
  });
}

async function getLatestGameStatePayload(page: Page): Promise<any> {
  return page.evaluate(() => (window as any).__lastGameState?.payload ?? null);
}

async function flipCell(page: Page, x: number, y: number, glyph: string, expectedStep: number): Promise<void> {
  const cell = page.getByTestId(`cell-${x}-${y}`);
  // 翻牌动画保护期内点击会被忽略，等待步数推进确认，未推进则补点一次。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await cell.click();
    const advanced = await page
      .waitForFunction(
        (step) => (document.querySelector('[data-testid="step-number"]')?.textContent ?? '').includes(`第 ${step} 步`),
        expectedStep,
        { timeout: 3000 },
      )
      .then(() => true)
      .catch(() => false);
    if (advanced) {
      break;
    }
  }
  await expectStep(page, expectedStep);
  await expect(cell).toHaveAttribute('data-cell-state', 'revealed', { timeout: 3000 });
  await expect(cell).toHaveAttribute('data-flip-phase', 'none', { timeout: 3000 });
  await expect(cell.locator('.piece-text')).toHaveText(glyph);
}

async function movePiece(
  page: Page,
  from: [number, number],
  to: [number, number],
  glyph: string,
  expectedStep: number,
): Promise<void> {
  const fromCell = page.getByTestId(`cell-${from[0]}-${from[1]}`);
  await fromCell.click();
  await expect(fromCell).toHaveClass(/selected/);
  await page.getByTestId(`cell-${to[0]}-${to[1]}`).click();
  await expectStep(page, expectedStep);
  await expect(page.getByTestId(`cell-${to[0]}-${to[1]}`).locator('.piece-text')).toHaveText(glyph);
}

test.describe('online real two-player checkmate and full-link regression', () => {
  test('seeded match reaches a real checkmate through flips, move, undo agreement, draw reject cooldown and reconnect recovery', async ({
    browser,
  }) => {
    const hostContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const hostPage = await hostContext.newPage();
    const hostErrors = watchConsole(hostPage);
    const room = await createRoom(hostPage);
    const guestContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const guestPage = await openGuest(guestContext, room.port);
    const guestErrors = watchConsole(guestPage);

    try {
      await joinRoom(guestPage, `127.0.0.1:${room.port}`);
      await startStandardMatch(hostPage, guestPage);

      // ====== 开局状态与固定明置将/帅核对 ======
      await expect(hostPage.getByTestId('turn-indicator')).toContainText('轮到你（红方）');
      await expect(guestPage.getByTestId('turn-indicator')).toContainText('等待对方行动（红方）');
      await expectStep(hostPage, 0);
      await expectStep(guestPage, 0);
      await expect(hostPage.getByTestId('cell-4-9').locator('.piece-text')).toHaveText('帅');
      await expect(hostPage.getByTestId('cell-4-0').locator('.piece-text')).toHaveText('将');
      await expect(guestPage.getByTestId('cell-4-9').locator('.piece-text')).toHaveText('帅');
      await expect(guestPage.getByTestId('cell-4-0').locator('.piece-text')).toHaveText('将');

      const initialHostCells = await getBoardGrid(hostPage);
      const initialGuestCells = await getBoardGrid(guestPage);
      expect(initialHostCells).toEqual(initialGuestCells);

      // 服务端权威快照：固定种子 42，双端同一对局
      const wsHostInit = await getLatestGameStatePayload(hostPage);
      const wsGuestInit = await getLatestGameStatePayload(guestPage);
      expect(wsHostInit.seed).toBe(42);
      expect(wsGuestInit.seed).toBe(42);
      expect(wsHostInit.matchId).toBe(wsGuestInit.matchId);
      expect(wsHostInit.state.pieces).toEqual(wsGuestInit.state.pieces);
      await captureEvidence(hostPage, 'online-checkmate-01-opening-host.png');

      // ====== 第 1 步：红方翻开 (2,3) -> 红俥 ======
      await flipCell(hostPage, 2, 3, '俥', 1);
      await expectStep(guestPage, 1);
      await expect(guestPage.getByTestId('cell-2-3').locator('.piece-text')).toHaveText('俥');
      await captureEvidence(hostPage, 'online-checkmate-02-rook-revealed.png');

      // ====== 第 2 步：黑方翻开 (0,3) -> 黑卒 ======
      await flipCell(guestPage, 0, 3, '卒', 2);
      await expectStep(hostPage, 2);

      // ====== 第 3 步：红方抬车 (2,3) -> (2,2) ======
      await movePiece(hostPage, [2, 3], [2, 2], '俥', 3);
      await expectStep(guestPage, 3);
      await expect(hostPage.getByTestId('turn-indicator')).toContainText('等待对方行动（黑方）');

      // ====== 悔棋协商：红方申请，黑方同意，单步回滚 ======
      await hostPage.getByTestId('btn-undo').click();
      await expect(hostPage.getByTestId('negotiation-dialog')).toBeVisible({ timeout: 5000 });
      await expect(guestPage.getByTestId('negotiation-dialog')).toBeVisible({ timeout: 5000 });
      await expect(hostPage.locator('.negotiation-waiting-state')).toBeVisible();
      await expect(guestPage.locator('.negotiation-title')).toContainText('对方申请悔棋');
      await expect(hostPage.locator('.board')).toHaveClass(/is-disabled/);
      await expect(guestPage.locator('.board')).toHaveClass(/is-disabled/);
      await captureEvidence(guestPage, 'online-checkmate-03-undo-negotiation.png');

      await guestPage.getByTestId('negotiation-agree-btn').click();
      await expect(hostPage.getByTestId('negotiation-dialog')).toHaveCount(0, { timeout: 5000 });
      await expect(guestPage.getByTestId('negotiation-dialog')).toHaveCount(0, { timeout: 5000 });
      await expect(hostPage.getByTestId('negotiation-toast')).toBeVisible();
      await expect(guestPage.getByTestId('negotiation-toast')).toBeVisible();

      // 回滚校验：第 3 步被撤销，回到第 2 步，俥回到 (2,3)，回合交还红方
      await expectStep(hostPage, 2);
      await expectStep(guestPage, 2);
      await expect(hostPage.getByTestId('turn-indicator')).toContainText('轮到你（红方）');
      await expect(guestPage.getByTestId('turn-indicator')).toContainText('等待对方行动（红方）');
      await expect(hostPage.getByTestId('cell-2-3').locator('.piece-text')).toHaveText('俥');
      await expect(guestPage.getByTestId('cell-2-3').locator('.piece-text')).toHaveText('俥');
      await expect(hostPage.getByTestId('cell-2-2').locator('.piece-text')).toHaveText('');
      await captureEvidence(hostPage, 'online-checkmate-04-undo-rollback.png');

      // ====== 第 3 步（重走）：红方抬车 (2,3) -> (2,2) ======
      await movePiece(hostPage, [2, 3], [2, 2], '俥', 3);
      await expectStep(guestPage, 3);

      // ====== 求和协商：黑方求和，红方拒绝，黑方求和按钮进入 10 秒冷却 ======
      await guestPage.getByTestId('btn-draw').click();
      await expect(hostPage.getByTestId('negotiation-dialog')).toBeVisible({ timeout: 5000 });
      await hostPage.getByTestId('negotiation-reject-btn').click();
      await expect(hostPage.getByTestId('negotiation-dialog')).toHaveCount(0, { timeout: 5000 });
      await expect(guestPage.getByTestId('negotiation-toast')).toBeVisible();
      await expect(guestPage.getByTestId('negotiation-toast')).toContainText('对方拒绝了求和申请');
      await expect(guestPage.getByTestId('btn-draw')).toBeDisabled();
      await expect(guestPage.getByTestId('btn-draw')).toHaveText(/求和 \(\d+s\)/);
      await captureEvidence(guestPage, 'online-checkmate-05-draw-reject-cooldown.png');

      // ====== 第 4 步：黑方翻开 (8,6) -> 黑卒 ======
      await flipCell(guestPage, 8, 6, '卒', 4);
      await expectStep(hostPage, 4);

      // ====== 断线恢复：客人 socket 断开并自动重连恢复 ======
      await guestPage.evaluate(() => {
        (window as any).__lastWelcome = null;
        (window as any).__roomWs?.close();
      });
      await expect(hostPage.getByTestId('member-guest')).toHaveClass(/offline/, { timeout: 5000 });
      await expect(hostPage.getByTestId('member-guest')).toContainText('已掉线');
      await expect
        .poll(async () => guestPage.evaluate(() => (window as any).__lastWelcome?.payload?.game?.stepNumber), {
          timeout: 10_000,
        })
        .toBe(4);
      await expect(hostPage.getByTestId('member-guest')).toHaveClass(/online/, { timeout: 5000 });
      await expectStep(guestPage, 4);
      await expect(hostPage.getByTestId('step-number')).toHaveText('第 4 步');
      const recoveredGuestCells = await getBoardGrid(guestPage);
      expect(recoveredGuestCells).toEqual(await getBoardGrid(hostPage));
      await captureEvidence(hostPage, 'online-checkmate-06-reconnect-recovered.png');

      // ====== 第 5 步：红方 (2,2) -> (4,2) 真实将死（不注入任何消息）======
      await movePiece(hostPage, [2, 2], [4, 2], '俥', 5);
      await expectStep(guestPage, 5);

      // 服务端权威终局：结算原因 checkmate，胜方 red
      const wsHostFinal = await getLatestGameStatePayload(hostPage);
      const wsGuestFinal = await getLatestGameStatePayload(guestPage);
      expect(wsHostFinal.settlement).not.toBeNull();
      expect(wsHostFinal.settlement.reason).toBe('checkmate');
      expect(wsHostFinal.settlement.winner).toBe('red');
      expect(wsGuestFinal.settlement).toEqual(wsHostFinal.settlement);
      expect(wsHostFinal.state.winner).toBe('red');
      expect(wsGuestFinal.state.winner).toBe('red');

      // 双端结算弹层：胜利方/失败方文案与绝杀原因
      const hostResultModal = hostPage.getByTestId('game-result-modal');
      const guestResultModal = guestPage.getByTestId('game-result-modal');
      await expect(hostResultModal).toBeVisible({ timeout: 10_000 });
      await expect(guestResultModal).toBeVisible({ timeout: 10_000 });
      await expect(hostPage.getByTestId('result-outcome-title')).toHaveText('胜利！');
      await expect(guestPage.getByTestId('result-outcome-title')).toHaveText('惜败');
      await expect(hostPage.getByTestId('result-reason')).toHaveText('绝杀：对方已被将死');
      await expect(guestPage.getByTestId('result-reason')).toHaveText('绝杀：对方已被将死');
      await expect(hostPage.getByTestId('result-stats')).toContainText('红方总用时');
      await expect(guestPage.getByTestId('result-stats')).toContainText('黑方总用时');
      await expect(hostPage.getByTestId('turn-indicator')).toHaveText('红方获胜');
      await expect(guestPage.getByTestId('turn-indicator')).toHaveText('红方获胜');
      await expect(hostPage.getByTestId('btn-rematch')).toBeVisible();
      await expect(guestPage.getByTestId('btn-return-lobby')).toBeVisible();

      // 终局后两端 90 格完全一致，无分叉
      const finalHostCells = await getBoardGrid(hostPage);
      const finalGuestCells = await getBoardGrid(guestPage);
      expect(finalHostCells).toEqual(finalGuestCells);
      await captureEvidence(hostPage, 'online-checkmate-07-checkmate-settlement-host.png');
      await captureEvidence(guestPage, 'online-checkmate-08-checkmate-settlement-guest.png');

      expect(hostErrors).toEqual([]);
      expect(guestErrors).toEqual([]);
    } finally {
      await teardownMatch(hostPage);
      await hostContext.close();
      await guestContext.close();
    }
  });

  test('draw agreement settlement closes the match as a negotiated draw on both ends', async ({ browser }) => {
    const hostContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const hostPage = await hostContext.newPage();
    const hostErrors = watchConsole(hostPage);
    const room = await createRoom(hostPage);
    const guestContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const guestPage = await openGuest(guestContext, room.port);
    const guestErrors = watchConsole(guestPage);

    try {
      await joinRoom(guestPage, `127.0.0.1:${room.port}`);
      await startStandardMatch(hostPage, guestPage);

      // 红方翻开 (0,6) -> 红炮，随后黑方求和、红方同意
      await flipCell(hostPage, 0, 6, '炮', 1);
      await guestPage.getByTestId('btn-draw').click();
      await expect(hostPage.getByTestId('negotiation-dialog')).toBeVisible({ timeout: 5000 });
      await hostPage.getByTestId('negotiation-agree-btn').click();

      // 双端进入终局结算弹层：平局、协商和棋
      await expect(hostPage.getByTestId('game-result-modal')).toBeVisible({ timeout: 5000 });
      await expect(guestPage.getByTestId('game-result-modal')).toBeVisible({ timeout: 5000 });
      await expect(hostPage.getByTestId('result-outcome-title')).toHaveText('平局');
      await expect(guestPage.getByTestId('result-outcome-title')).toHaveText('平局');
      await expect(hostPage.getByTestId('result-reason')).toHaveText('双方握手言和，协商平局');
      await expect(guestPage.getByTestId('result-reason')).toHaveText('双方握手言和，协商平局');
      await expect(hostPage.getByTestId('celebration-piece')).toContainText('和');
      await expect(guestPage.getByTestId('celebration-piece')).toContainText('和');

      const wsHostFinal = await getLatestGameStatePayload(hostPage);
      expect(wsHostFinal.settlement.reason).toBe('draw-agreement');
      expect(wsHostFinal.settlement.winner).toBeNull();
      await captureEvidence(hostPage, 'online-checkmate-09-draw-agreement-settlement.png');

      expect(hostErrors).toEqual([]);
      expect(guestErrors).toEqual([]);
    } finally {
      await teardownMatch(hostPage);
      await hostContext.close();
      await guestContext.close();
    }
  });
});
