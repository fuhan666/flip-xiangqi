import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';

const EVIDENCE_DIR = path.resolve(process.cwd(), '../evidence');

interface RoomHandle {
  address: string;
  port: number;
}

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}

async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ fullPage: true, path: path.join(EVIDENCE_DIR, `online-game-${name}.png`) });
}

async function installWebSocketSpy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    (window as any).__wsMessages = [];
    (window as any).__lastGameState = null;
    (window as any).__lastWelcome = null;
    (window as any).__corruptNextActionStep = false;

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
            if (data.type === 'game.rejected') {
              (window as any).__lastRejected = data;
            }
          } catch {}
        });

        const origSend = this.send.bind(this);
        this.send = (data: any) => {
          try {
            const parsed = typeof data === 'string' ? JSON.parse(data) : null;
            if (parsed && parsed.type === 'game.action' && (window as any).__corruptNextActionStep) {
              (window as any).__corruptNextActionStep = false;
              parsed.payload.stepNumber = 999;
              data = JSON.stringify(parsed);
            }
          } catch {}
          return origSend(data);
        };
      }
    };
  });
}

async function createRoom(page: Page): Promise<RoomHandle> {
  await installWebSocketSpy(page);
  await page.goto('/');
  await page.getByTestId('menu-create').click();
  const addressElement = page.getByTestId('room-address-main');
  await expect(addressElement).toBeVisible();
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

async function getBoardGrid(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const cells: string[] = [];
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 9; x++) {
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

test.describe('online game flow: seed sync, actions, rollback, and reconnection', () => {
  test('bidirectional FLIP/MOVE/capture, 90-cell sync, server rejection rollback & retry, and reconnect recovery', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const hostErrors = watchConsole(hostPage);
    const room = await createRoom(hostPage);

    const guestContext = await browser.newContext();
    const guestPage = await openGuest(guestContext, room.port);
    const guestErrors = watchConsole(guestPage);
    await joinRoom(guestPage, `127.0.0.1:${room.port}`);

    // 房主选择 host-red（房主执红先行，客人执黑后行）
    await hostPage.getByTestId('setting-side-host-red').click({ force: true });
    await guestPage.getByTestId('lobby-ready-toggle').click();
    await expect(guestPage.getByTestId('lobby-ready-toggle')).toHaveText('取消准备', { timeout: 10_000 });
    await hostPage.getByTestId('lobby-ready-toggle').click();
    await expect(hostPage.getByTestId('lobby-start-hint')).toContainText('双方已就绪', { timeout: 10_000 });
    await expect(hostPage.getByTestId('lobby-start')).toHaveClass(/panel-action-gold/);

    // 房主开局
    await hostPage.getByTestId('lobby-start').click();

    // 双方进入对局棋盘
    await expect(hostPage.getByTestId('online-game')).toBeVisible({ timeout: 10_000 });
    await expect(guestPage.getByTestId('online-game')).toBeVisible({ timeout: 10_000 });

    // 洗牌中提示在 ≤500ms 后自动隐藏
    await expect(hostPage.getByTestId('shuffling-banner')).toHaveCount(0, { timeout: 2000 });
    await expect(guestPage.getByTestId('shuffling-banner')).toHaveCount(0, { timeout: 2000 });

    // 核对开局状态与第 0 步
    await expect(hostPage.getByTestId('turn-indicator')).toContainText('轮到你（红方）');
    await expect(guestPage.getByTestId('turn-indicator')).toContainText('等待对方行动（红方）');
    await expect(hostPage.getByTestId('step-number')).toHaveText('第 0 步');
    await expect(guestPage.getByTestId('step-number')).toHaveText('第 0 步');

    // 双方固定明置将/帅位置核对
    await expect(hostPage.getByTestId('cell-4-9')).toContainText('帅');
    await expect(guestPage.getByTestId('cell-4-9')).toContainText('帅');
    await expect(hostPage.getByTestId('cell-4-0')).toContainText('将');
    await expect(guestPage.getByTestId('cell-4-0')).toContainText('将');

    // 比较两端完整 90 格初始布局
    const initialHostCells = await getBoardGrid(hostPage);
    const initialGuestCells = await getBoardGrid(guestPage);
    expect(initialHostCells).toEqual(initialGuestCells);

    // WS 层核对初始快照：种子、步数、回合、32 枚棋子属性完全一致
    const wsHostInit = await getLatestGameStatePayload(hostPage);
    const wsGuestInit = await getLatestGameStatePayload(guestPage);
    expect(wsHostInit).not.toBeNull();
    expect(wsGuestInit).not.toBeNull();
    expect(wsHostInit.matchId).toBe(wsGuestInit.matchId);
    expect(wsHostInit.seed).toBe(42);
    expect(wsGuestInit.seed).toBe(42);
    expect(wsHostInit.stepNumber).toBe(0);
    expect(wsGuestInit.stepNumber).toBe(0);
    expect(wsHostInit.state.pieces).toEqual(wsGuestInit.state.pieces);

    await screenshot(hostPage, '01-opening-host');
    await screenshot(guestPage, '02-opening-guest');

    // 非法行动拦截：客人在红方回合尝试翻牌 -> 本地拦截并提示
    await guestPage.getByTestId('cell-0-6').click();
    await expect(guestPage.locator('.hint[role="status"]')).toContainText('当前非己方回合');
    await expect(guestPage.getByTestId('step-number')).toHaveText('第 0 步');

    // ====== 第一步：红方（房主）翻开 (0, 6)（红炮）======
    await hostPage.getByTestId('cell-0-6').click();

    // 双方均看到步数前进到第 1 步，轮到黑方
    await expect(hostPage.getByTestId('step-number')).toHaveText('第 1 步', { timeout: 5000 });
    await expect(guestPage.getByTestId('step-number')).toHaveText('第 1 步', { timeout: 5000 });
    await expect(hostPage.getByTestId('turn-indicator')).toContainText('等待对方行动（黑方）');
    await expect(guestPage.getByTestId('turn-indicator')).toContainText('轮到你（黑方）');

    // (0, 6) 的棋子已被翻开且两端显示同一文字（炮）
    await expect(hostPage.locator('[data-testid="cell-0-6"] .piece-text')).toHaveText('炮', { timeout: 5000 });
    await expect(guestPage.locator('[data-testid="cell-0-6"] .piece-text')).toHaveText('炮', { timeout: 5000 });
    await expect(hostPage.locator('[data-testid="cell-0-6"]')).toHaveAttribute('data-flip-phase', 'none', { timeout: 3000 });
    await expect(guestPage.locator('[data-testid="cell-0-6"]')).toHaveAttribute('data-flip-phase', 'none', { timeout: 3000 });

    // 90 格与 WS 层核对
    const step1HostCells = await getBoardGrid(hostPage);
    const step1GuestCells = await getBoardGrid(guestPage);
    expect(step1HostCells).toEqual(step1GuestCells);
    const wsHostStep1 = await getLatestGameStatePayload(hostPage);
    const wsGuestStep1 = await getLatestGameStatePayload(guestPage);
    expect(wsHostStep1.stepNumber).toBe(1);
    expect(wsGuestStep1.stepNumber).toBe(1);
    expect(wsHostStep1.state.pieces).toEqual(wsGuestStep1.state.pieces);

    await screenshot(hostPage, '03-after-first-flip-host');
    await screenshot(guestPage, '04-after-first-flip-guest');

    // ====== 第二步：黑方（客人）翻开 (0, 0)（黑砲）======
    await guestPage.getByTestId('cell-0-0').click();

    // 双方均看到步数前进到第 2 步，轮到红方
    await expect(hostPage.getByTestId('step-number')).toHaveText('第 2 步', { timeout: 5000 });
    await expect(guestPage.getByTestId('step-number')).toHaveText('第 2 步', { timeout: 5000 });
    await expect(hostPage.getByTestId('turn-indicator')).toContainText('轮到你（红方）');
    await expect(guestPage.getByTestId('turn-indicator')).toContainText('等待对方行动（红方）');

    await expect(hostPage.locator('[data-testid="cell-0-0"] .piece-text')).toHaveText('砲', { timeout: 5000 });
    await expect(guestPage.locator('[data-testid="cell-0-0"] .piece-text')).toHaveText('砲', { timeout: 5000 });
    await expect(hostPage.locator('[data-testid="cell-0-0"]')).toHaveAttribute('data-flip-phase', 'none', { timeout: 3000 });
    await expect(guestPage.locator('[data-testid="cell-0-0"]')).toHaveAttribute('data-flip-phase', 'none', { timeout: 3000 });

    // 90 格与 WS 层核对
    const step2HostCells = await getBoardGrid(hostPage);
    const step2GuestCells = await getBoardGrid(guestPage);
    expect(step2HostCells).toEqual(step2GuestCells);

    // ====== 测试服务端拒绝与平滑回滚（本地合法推测但服务端权威拦截）======
    // 测试侧在房主发送动作前设置注入：篡改上行步数为 999
    await hostPage.evaluate(() => {
      (window as any).__corruptNextActionStep = true;
    });

    // 房主尝试走子：(0, 6) 炮 翻山跳过 (0, 3) 暗子吃 (0, 0) 黑砲
    // 本地校验通过并乐观呈现，但发送到服务端的 stepNumber 畸形 (999)
    await hostPage.getByTestId('cell-0-6').click();
    await expect(hostPage.locator('[data-testid="cell-0-6"]')).toHaveClass(/selected/);
    await hostPage.getByTestId('cell-0-0').click();

    // 断言服务端返回权威拒绝并下发固定提示文案
    await expect(hostPage.getByTestId('online-rejection-notice')).toHaveText('你的操作未被采纳，请重新操作', { timeout: 5000 });

    // 步数保持在第 2 步，棋盘平滑回滚至权威状态：(0, 6) 仍为红炮，(0, 0) 仍为黑砲
    await expect(hostPage.getByTestId('step-number')).toHaveText('第 2 步');
    await expect(hostPage.locator('[data-testid="cell-0-6"] .piece-text')).toHaveText('炮');
    await expect(hostPage.locator('[data-testid="cell-0-0"] .piece-text')).toHaveText('砲');

    // 90 格双方状态完全一致，无分叉
    const rollbackHostCells = await getBoardGrid(hostPage);
    const rollbackGuestCells = await getBoardGrid(guestPage);
    expect(rollbackHostCells).toEqual(rollbackGuestCells);

    // ====== 同一步重试：在同一第 2 步再次正常走子吃子 ======
    await hostPage.getByTestId('cell-0-6').click();
    await expect(hostPage.locator('[data-testid="cell-0-6"]')).toHaveClass(/selected/);
    await hostPage.getByTestId('cell-0-0').click();

    // 成功通过权威校验，步数前进到第 3 步，轮到黑方
    await expect(hostPage.getByTestId('step-number')).toHaveText('第 3 步', { timeout: 5000 });
    await expect(guestPage.getByTestId('step-number')).toHaveText('第 3 步', { timeout: 5000 });
    await expect(hostPage.getByTestId('turn-indicator')).toContainText('等待对方行动（黑方）');
    await expect(guestPage.getByTestId('turn-indicator')).toContainText('轮到你（黑方）');

    // (0, 6) 现为空，(0, 0) 为红炮（黑炮被吃）
    await expect(hostPage.locator('[data-testid="cell-0-6"] .piece-text')).toHaveText('', { timeout: 5000 });
    await expect(guestPage.locator('[data-testid="cell-0-6"] .piece-text')).toHaveText('', { timeout: 5000 });
    await expect(hostPage.locator('[data-testid="cell-0-0"] .piece-text')).toHaveText('炮');
    await expect(guestPage.locator('[data-testid="cell-0-0"] .piece-text')).toHaveText('炮');

    // WS 层核对吃子标记与历史
    const wsHostStep3 = await getLatestGameStatePayload(hostPage);
    expect(wsHostStep3.stepNumber).toBe(3);
    const capturedBlackCannon = wsHostStep3.state.pieces.find((p: any) => p.id === 'black-cannon-1');
    expect(capturedBlackCannon.captured).toBe(true);
    expect(capturedBlackCannon.position).toBeNull();

    // ====== 第四步：黑方（客人）翻开 (0, 3)（黑卒）======
    await guestPage.getByTestId('cell-0-3').click();
    await expect(hostPage.getByTestId('step-number')).toHaveText('第 4 步', { timeout: 5000 });
    await expect(guestPage.getByTestId('step-number')).toHaveText('第 4 步', { timeout: 5000 });
    await expect(hostPage.locator('[data-testid="cell-0-3"] .piece-text')).toHaveText('卒');
    await expect(guestPage.locator('[data-testid="cell-0-3"] .piece-text')).toHaveText('卒');
    await expect(hostPage.locator('[data-testid="cell-0-3"]')).toHaveAttribute('data-flip-phase', 'none', { timeout: 3000 });
    await expect(guestPage.locator('[data-testid="cell-0-3"]')).toHaveAttribute('data-flip-phase', 'none', { timeout: 3000 });

    // ====== 第五步：红方（房主）翻开 (4, 3)（黑卒）======
    await hostPage.getByTestId('cell-4-3').click();
    await expect(hostPage.getByTestId('step-number')).toHaveText('第 5 步', { timeout: 5000 });
    await expect(guestPage.getByTestId('step-number')).toHaveText('第 5 步', { timeout: 5000 });
    await expect(hostPage.locator('[data-testid="cell-4-3"] .piece-text')).toHaveText('卒');
    await expect(guestPage.locator('[data-testid="cell-4-3"] .piece-text')).toHaveText('卒');
    await expect(hostPage.locator('[data-testid="cell-4-3"]')).toHaveAttribute('data-flip-phase', 'none', { timeout: 3000 });
    await expect(guestPage.locator('[data-testid="cell-4-3"]')).toHaveAttribute('data-flip-phase', 'none', { timeout: 3000 });

    // ====== 第六步：黑方（客人）走子 MOVE (0, 3) -> (0, 4) ======
    await guestPage.getByTestId('cell-0-3').click();
    await expect(guestPage.locator('[data-testid="cell-0-3"]')).toHaveClass(/selected/);
    await guestPage.getByTestId('cell-0-4').click();

    // 双方均看到步数前进到第 6 步，轮到红方
    await expect(hostPage.getByTestId('step-number')).toHaveText('第 6 步', { timeout: 5000 });
    await expect(guestPage.getByTestId('step-number')).toHaveText('第 6 步', { timeout: 5000 });
    await expect(hostPage.getByTestId('turn-indicator')).toContainText('轮到你（红方）');
    await expect(guestPage.getByTestId('turn-indicator')).toContainText('等待对方行动（红方）');

    // 卒从 (0, 3) 移到了 (0, 4)
    await expect(hostPage.locator('[data-testid="cell-0-3"] .piece-text')).toHaveText('');
    await expect(guestPage.locator('[data-testid="cell-0-3"] .piece-text')).toHaveText('');
    await expect(hostPage.locator('[data-testid="cell-0-4"] .piece-text')).toHaveText('卒');
    await expect(guestPage.locator('[data-testid="cell-0-4"] .piece-text')).toHaveText('卒');

    // 双方 90 格完整比较
    const step6HostCells = await getBoardGrid(hostPage);
    const step6GuestCells = await getBoardGrid(guestPage);
    expect(step6HostCells).toEqual(step6GuestCells);

    // ====== 断线恢复验证 A：客人 socket 断开并重新握手恢复 ======
    await guestPage.evaluate(() => {
      (window as any).__lastWelcome = null;
      (window as any).__roomWs?.close();
    });

    // 房主端观察到客人状态徽章变为已掉线
    await expect(hostPage.getByTestId('member-guest')).toHaveClass(/offline/, { timeout: 5000 });
    await expect(hostPage.getByTestId('member-guest')).toContainText('已掉线');

    // 客人重新握手收到 welcome（含权威对局快照）
    await expect.poll(async () => {
      return guestPage.evaluate(() => (window as any).__lastWelcome?.payload?.game?.stepNumber);
    }, { timeout: 10_000 }).toBe(6);

    // 房主端观察到客人恢复在线
    await expect(hostPage.getByTestId('member-guest')).toHaveClass(/online/, { timeout: 5000 });
    await expect(hostPage.getByTestId('member-guest')).toContainText('在线');

    // 客人端对局与 90 格完全恢复，步数保持在第 6 步，无历史动画
    await expect(guestPage.getByTestId('step-number')).toHaveText('第 6 步', { timeout: 5000 });
    const recoveredGuestCells = await getBoardGrid(guestPage);
    expect(recoveredGuestCells).toEqual(step6HostCells);

    // ====== 断线恢复验证 B：房主 socket 断开并重新握手恢复 ======
    await hostPage.evaluate(() => {
      (window as any).__lastWelcome = null;
      (window as any).__roomWs?.close();
    });

    // 客人端观察到房主状态徽章变为已掉线
    await expect(guestPage.getByTestId('member-host')).toHaveClass(/offline/, { timeout: 5000 });
    await expect(guestPage.getByTestId('member-host')).toContainText('已掉线');

    // 房主重新握手收到 welcome（含权威对局快照）
    await expect.poll(async () => {
      return hostPage.evaluate(() => (window as any).__lastWelcome?.payload?.game?.stepNumber);
    }, { timeout: 10_000 }).toBe(6);

    // 客人端观察到房主恢复在线
    await expect(guestPage.getByTestId('member-host')).toHaveClass(/online/, { timeout: 5000 });
    await expect(guestPage.getByTestId('member-host')).toContainText('在线');

    // 房主端对局与 90 格完全恢复，步数保持在第 6 步
    await expect(hostPage.getByTestId('step-number')).toHaveText('第 6 步', { timeout: 5000 });
    const recoveredHostCells = await getBoardGrid(hostPage);
    expect(recoveredHostCells).toEqual(step6GuestCells);

    // 房主主动关闭房间，验证主动关房流程并清理套件环境
    await hostPage.getByTestId('close-room').click();
    await hostPage.getByTestId('confirm-yes').click();
    await expect(hostPage.getByTestId('menu-create')).toBeVisible({ timeout: 5000 });

    expect(hostErrors).toEqual([]);
    expect(guestErrors).toEqual([]);

    await hostContext.close();
    await guestContext.close();
  });
});
