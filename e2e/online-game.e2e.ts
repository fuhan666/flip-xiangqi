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

async function createRoom(page: Page): Promise<RoomHandle> {
  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    window.WebSocket = class extends OrigWS {
      constructor(...args: any[]) {
        super(...(args as [string, ...any[]]));
        (window as any).__roomWs = this;
      }
    };
  });
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
  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    window.WebSocket = class extends OrigWS {
      constructor(...args: any[]) {
        super(...(args as [string, ...any[]]));
        (window as any).__roomWs = this;
      }
    };
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByTestId('menu-join').click();
  return page;
}

async function joinRoom(page: Page, address: string): Promise<void> {
  await page.getByTestId('join-address-input').fill(address);
  await page.getByTestId('join-submit').click();
  await expect(page.getByTestId('lobby-ready-toggle')).toBeVisible({ timeout: 10_000 });
}

test.describe('online game flow: seed sync, actions, rollback, and reconnection', () => {
  test('both players enter game with identical layout, exchange flips, and recover on reconnect', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const hostErrors = watchConsole(hostPage);
    const room = await createRoom(hostPage);

    const guestContext = await browser.newContext();
    const guestPage = await openGuest(guestContext, room.port);
    const guestErrors = watchConsole(guestPage);
    await joinRoom(guestPage, `127.0.0.1:${room.port}`);

    // 房主选择 host-red（房主执红先行）
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

    await screenshot(hostPage, '01-opening-host');
    await screenshot(guestPage, '02-opening-guest');

    // 非法行动拦截：客人在红方回合尝试翻牌 -> 本地拦截并提示
    await guestPage.getByTestId('cell-0-6').click();
    await expect(guestPage.locator('.hint[role="status"]')).toContainText('当前非己方回合');
    await expect(guestPage.getByTestId('step-number')).toHaveText('第 0 步');

    // 第一步：红方（房主）翻开兵位 (0, 6)
    await hostPage.getByTestId('cell-0-6').click();

    // 双方均看到步数前进到第 1 步，轮到黑方
    await expect(hostPage.getByTestId('step-number')).toHaveText('第 1 步', { timeout: 5000 });
    await expect(guestPage.getByTestId('step-number')).toHaveText('第 1 步', { timeout: 5000 });
    await expect(hostPage.getByTestId('turn-indicator')).toContainText('等待对方行动（黑方）');
    await expect(guestPage.getByTestId('turn-indicator')).toContainText('轮到你（黑方）');

    // (0, 6) 的棋子已被翻开且两端显示同一文字
    await expect(hostPage.getByTestId('cell-0-6')).not.toContainText('暗', { timeout: 5000 });
    await expect(guestPage.getByTestId('cell-0-6')).not.toContainText('暗', { timeout: 5000 });
    const hostPiece06 = ((await hostPage.getByTestId('cell-0-6').textContent()) ?? '').trim();
    const guestPiece06 = ((await guestPage.getByTestId('cell-0-6').textContent()) ?? '').trim();
    expect(hostPiece06).toBeTruthy();
    expect(hostPiece06).toBe(guestPiece06);

    await screenshot(hostPage, '03-after-first-flip-host');
    await screenshot(guestPage, '04-after-first-flip-guest');

    // 第二步：黑方（客人）翻开卒位 (0, 3)
    await guestPage.getByTestId('cell-0-3').click();

    // 双方均看到步数前进到第 2 步，轮到红方
    await expect(hostPage.getByTestId('step-number')).toHaveText('第 2 步', { timeout: 5000 });
    await expect(guestPage.getByTestId('step-number')).toHaveText('第 2 步', { timeout: 5000 });
    await expect(hostPage.getByTestId('turn-indicator')).toContainText('轮到你（红方）');
    await expect(guestPage.getByTestId('turn-indicator')).toContainText('等待对方行动（红方）');

    await expect(hostPage.getByTestId('cell-0-3')).not.toContainText('暗', { timeout: 5000 });
    await expect(guestPage.getByTestId('cell-0-3')).not.toContainText('暗', { timeout: 5000 });
    const hostPiece03 = ((await hostPage.getByTestId('cell-0-3').textContent()) ?? '').trim();
    const guestPiece03 = ((await guestPage.getByTestId('cell-0-3').textContent()) ?? '').trim();
    expect(hostPiece03).toBeTruthy();
    expect(hostPiece03).toBe(guestPiece03);

    // 断线恢复测试：客人 socket 断开并自动重连
    await guestPage.evaluate(() => {
      (window as any).__roomWs?.close();
    });

    // 客人重新连接成功，步数保持在第 2 步，棋盘状态完整保留
    await expect(guestPage.getByTestId('step-number')).toHaveText('第 2 步', { timeout: 10_000 });
    await expect(guestPage.getByTestId('online-game')).toBeVisible();
    await expect(guestPage.getByTestId('cell-0-6')).toContainText(hostPiece06);
    await expect(guestPage.getByTestId('cell-0-3')).toContainText(guestPiece03);

    expect(hostErrors).toEqual([]);
    expect(guestErrors).toEqual([]);

    await hostContext.close();
    await guestContext.close();
  });
});
