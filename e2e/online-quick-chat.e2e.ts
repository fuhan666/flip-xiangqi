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

async function startStandardMatch(hostPage: Page, guestPage: Page): Promise<void> {
  await hostPage.getByTestId('setting-side-host-red').click({ force: true });
  await guestPage.getByTestId('lobby-ready-toggle').click();
  await expect(guestPage.getByTestId('lobby-ready-toggle')).toHaveText('取消准备', { timeout: 10_000 });
  await hostPage.getByTestId('lobby-ready-toggle').click();
  await expect(hostPage.getByTestId('lobby-start-hint')).toContainText('双方已就绪', { timeout: 10_000 });
  await hostPage.getByTestId('lobby-start').click();

  await expect(hostPage.getByTestId('online-game')).toBeVisible({ timeout: 10_000 });
  await expect(guestPage.getByTestId('online-game')).toBeVisible({ timeout: 10_000 });
  await expect(hostPage.getByTestId('shuffling-banner')).toHaveCount(0, { timeout: 3000 });
  await expect(guestPage.getByTestId('shuffling-banner')).toHaveCount(0, { timeout: 3000 });
}

test.describe('quick phrase interactions, cooldown and multi-viewport regression', () => {
  test('preset phrases, 3s bubble display, 5s cooldown and responsive layouts', async ({ browser }) => {
    const hostContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const hostPage = await hostContext.newPage();
    const hostErrors = watchConsole(hostPage);

    const room = await createRoom(hostPage);

    const guestContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const guestPage = await guestContext.newPage();
    const guestErrors = watchConsole(guestPage);
    await installWebSocketSpy(guestPage);
    await guestPage.goto(`http://127.0.0.1:${room.port}/`);
    await guestPage.getByTestId('menu-join').click();
    await joinRoom(guestPage, `127.0.0.1:${room.port}`);

    await startStandardMatch(hostPage, guestPage);

    // 1. 验证短语入口与展开面板
    const phraseBtn = hostPage.getByTestId('btn-quick-phrase');
    await expect(phraseBtn).toBeVisible();
    await expect(phraseBtn).toHaveText('短语');

    // 验证触控目标尺寸 >= 44x44
    const btnBox = await phraseBtn.boundingBox();
    expect(btnBox).not.toBeNull();
    if (btnBox) {
      expect(btnBox.width).toBeGreaterThanOrEqual(44);
      expect(btnBox.height).toBeGreaterThanOrEqual(44);
    }

    // 点击展开面板
    await phraseBtn.click();
    const popover = hostPage.getByTestId('quick-phrase-popover');
    await expect(popover).toBeVisible();

    // 验证包含 12 条内置短语
    const items = popover.locator('.quick-phrase-item-btn');
    await expect(items).toHaveCount(12);

    // 截图 1: 短语面板展开
    await captureEvidence(hostPage, 'quick-phrase-01-panel-open-1366x768.png');

    // 2. 点选第一条短语（"你好，很高兴和你对弈！"）
    const firstPhrase = hostPage.getByTestId('quick-phrase-item-phrase-greeting-1');
    await expect(firstPhrase).toContainText('你好，很高兴和你对弈！');
    await firstPhrase.click();

    // 弹层自动收起
    await expect(popover).toHaveCount(0);

    // 3. 验证气泡展示：房主端自底侧气泡，客人端顶侧气泡
    const hostSelfBubble = hostPage.getByTestId('phrase-bubble-self');
    const guestOpponentBubble = guestPage.getByTestId('phrase-bubble-opponent');

    await expect(hostSelfBubble).toBeVisible({ timeout: 5000 });
    await expect(hostSelfBubble).toContainText('你好，很高兴和你对弈！');
    await expect(guestOpponentBubble).toBeVisible({ timeout: 5000 });
    await expect(guestOpponentBubble).toContainText('你好，很高兴和你对弈！');

    // 截图 2: 气泡展示
    await captureEvidence(guestPage, 'quick-phrase-02-bubble-display.png');

    // 4. 验证 5 秒防刷屏频控：按钮显示倒计时且不可点击
    await expect(phraseBtn).toHaveText(/短语 \(\d+s\)/);
    await expect(phraseBtn).toBeDisabled();

    // 截图 3: 5s 频控倒计时生效
    await captureEvidence(hostPage, 'quick-phrase-03-cooldown-active.png');

    // 5. 验证 3 秒气泡平滑淡出
    await expect(hostSelfBubble).toHaveCount(0, { timeout: 4500 });
    await expect(guestOpponentBubble).toHaveCount(0, { timeout: 4500 });

    // 6. 等待 5 秒频控倒计时结束
    await expect(phraseBtn).toHaveText('短语', { timeout: 6000 });
    await expect(phraseBtn).toBeEnabled();

    // 7. 客人端发送赞赏短语（"佩服佩服！"）
    const guestPhraseBtn = guestPage.getByTestId('btn-quick-phrase');
    await guestPhraseBtn.click();
    const guestPopover = guestPage.getByTestId('quick-phrase-popover');
    await expect(guestPopover).toBeVisible();

    const guestPraise = guestPage.getByTestId('quick-phrase-item-phrase-praise-3');
    await expect(guestPraise).toContainText('佩服佩服！');
    await guestPraise.click();

    // 房主端收到对手气泡
    const hostOpponentBubble = hostPage.getByTestId('phrase-bubble-opponent');
    await expect(hostOpponentBubble).toBeVisible({ timeout: 5000 });
    await expect(hostOpponentBubble).toContainText('佩服佩服！');

    // 8. 走棋不受短语影响：红方执行一次翻牌
    await hostPage.getByTestId('cell-0-6').click();
    await expect(hostPage.getByTestId('step-number')).toContainText('第 1 步');
    await expect(guestPage.getByTestId('step-number')).toContainText('第 1 步');

    // 9. 多视口无溢出检查 (1366x768, 1920x1080, 683x768)
    const viewports = [
      { name: '1366x768', width: 1366, height: 768, filename: 'quick-phrase-04-viewport-1366x768.png' },
      { name: '1920x1080', width: 1920, height: 1080, filename: 'quick-phrase-05-viewport-1920x1080.png' },
      { name: 'half-683x768', width: 683, height: 768, filename: 'quick-phrase-06-viewport-half-683x768.png' },
    ];

    for (const vp of viewports) {
      await hostPage.setViewportSize({ width: vp.width, height: vp.height });
      await hostPage.waitForTimeout(300);

      const overflow = await hostPage.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth + 1);

      await captureEvidence(hostPage, vp.filename);
    }

    // 10. 退出并彻底释放房间
    await teardownMatch(hostPage);

    expect(hostErrors).toEqual([]);
    expect(guestErrors).toEqual([]);

    await hostContext.close();
    await guestContext.close();
  });
});
