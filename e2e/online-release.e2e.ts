import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const EVIDENCE_DIR = path.resolve(process.cwd(), '../evidence');
if (!fs.existsSync(EVIDENCE_DIR)) {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

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

async function captureEvidence(page: Page, filename: string): Promise<string> {
  const targetPath = path.join(EVIDENCE_DIR, filename);
  await page.screenshot({ fullPage: false, path: targetPath });
  return targetPath;
}

async function installWebSocketSpy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    (window as any).__wsMessages = [];
    (window as any).__lastGameState = null;

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
          } catch {}
        });
      }
    };
  });
}

async function teardownMatch(hostPage: Page): Promise<void> {
  try {
    const resignBtn = hostPage.getByTestId('btn-resign');
    if (await resignBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await resignBtn.click({ force: true }).catch(() => {});
      const confirmResign = hostPage.getByTestId('confirm-resign-btn');
      if (await confirmResign.isVisible({ timeout: 1000 }).catch(() => false)) {
        await confirmResign.click({ force: true }).catch(() => {});
        await hostPage.waitForTimeout(500);
      }
    }

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
    // 忽略清理异常
  }
}

async function createRoom(page: Page): Promise<RoomHandle> {
  await installWebSocketSpy(page);
  await page.goto('/');

  // 清理可能遗留的旧对局或大厅
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

test.describe('v0.8.0 online release full lifecycle and settlement regression', () => {
  test('verifies version v0.8.0, full match loop, phrase exchange, resignation and settlement', async ({ browser }) => {
    const hostContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const hostPage = await hostContext.newPage();
    const hostErrors = watchConsole(hostPage);

    // 1. 验证首页版本号显示为 v0.8.0
    await hostPage.goto('/');
    const versionBadge = hostPage.getByTestId('app-version');
    await expect(versionBadge).toBeVisible();
    await expect(versionBadge).toHaveText('v0.8.0');
    await captureEvidence(hostPage, 'online-release-01-version-v0.8.0.png');

    // 2. 房主建房
    const room = await createRoom(hostPage);

    // 3. 客人加入
    const guestContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const guestPage = await openGuest(guestContext, room.port);
    const guestErrors = watchConsole(guestPage);
    await joinRoom(guestPage, `127.0.0.1:${room.port}`);

    // 4. 双方准备并开局
    await hostPage.getByTestId('setting-side-host-red').click({ force: true });
    await guestPage.getByTestId('lobby-ready-toggle').click();
    await expect(guestPage.getByTestId('lobby-ready-toggle')).toHaveText('取消准备', { timeout: 10_000 });
    await hostPage.getByTestId('lobby-ready-toggle').click();
    await expect(hostPage.getByTestId('lobby-start-hint')).toContainText('双方已就绪', { timeout: 10_000 });
    await hostPage.getByTestId('lobby-start').click();

    await expect(hostPage.getByTestId('online-game')).toBeVisible({ timeout: 10_000 });
    await expect(guestPage.getByTestId('online-game')).toBeVisible({ timeout: 10_000 });
    await expect(hostPage.getByTestId('shuffling-banner')).toHaveCount(0, { timeout: 3000 });

    // 5. 红方（房主）执行第 1 步翻牌
    await hostPage.getByTestId('cell-0-6').click();
    await expect(hostPage.getByTestId('step-number')).toContainText('第 1 步');
    await expect(guestPage.getByTestId('step-number')).toContainText('第 1 步');
    await expect(hostPage.locator('[data-testid="cell-0-6"]')).toHaveAttribute('data-flip-phase', 'none', { timeout: 3000 });

    // 6. 黑方（客人）执行第 2 步翻牌
    await guestPage.getByTestId('cell-0-0').click();
    await expect(hostPage.getByTestId('step-number')).toContainText('第 2 步');
    await expect(guestPage.getByTestId('step-number')).toContainText('第 2 步');

    // 截图 2: 完整对局进行中（第 2 步走完）
    await captureEvidence(hostPage, 'online-release-02-full-match-gameplay.png');

    // 7. 房主发起认输，触发结算弹窗
    const resignBtn = hostPage.getByTestId('btn-resign');
    await resignBtn.click();
    const resignDialog = hostPage.getByTestId('resign-confirm-dialog');
    await expect(resignDialog).toBeVisible();

    const confirmResign = hostPage.getByTestId('confirm-resign-btn');
    await confirmResign.click();

    // 8. 双方展示结算对话框
    const hostResultModal = hostPage.getByTestId('game-result-modal');
    const guestResultModal = guestPage.getByTestId('game-result-modal');
    await expect(hostResultModal).toBeVisible({ timeout: 10_000 });
    await expect(guestResultModal).toBeVisible({ timeout: 10_000 });

    await expect(hostPage.getByTestId('result-reason')).toContainText('认输');
    await expect(guestPage.getByTestId('result-reason')).toContainText('认输');

    // 截图 3: 终局结算弹窗
    await captureEvidence(hostPage, 'online-release-03-match-settlement.png');

    // 9. 返回大厅
    await hostPage.getByTestId('btn-return-lobby').click();
    await expect(hostPage.getByTestId('lobby-ready-toggle')).toBeVisible({ timeout: 10_000 });

    // 10. 释放房间
    await teardownMatch(hostPage);

    expect(hostErrors).toEqual([]);
    expect(guestErrors).toEqual([]);

    await hostContext.close();
    await guestContext.close();
  });
});
