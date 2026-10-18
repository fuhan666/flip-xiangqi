import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const ATTACHMENTS_DIR = path.resolve(process.cwd(), 'attachments');
if (!fs.existsSync(ATTACHMENTS_DIR)) {
  fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
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
  const targetPath = path.join(ATTACHMENTS_DIR, filename);
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

  // 若存在残留的房间或对局界面，先主动关闭释放
  const returnLobbyBtn = page.getByTestId('btn-return-lobby');
  if (await returnLobbyBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await returnLobbyBtn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
  }

  const activeClose = page.getByTestId('close-room');
  if (await activeClose.isVisible({ timeout: 1000 }).catch(() => false)) {
    await activeClose.click({ force: true }).catch(() => {});
    const confirm = page.getByTestId('confirm-yes');
    if (await confirm.isVisible({ timeout: 1000 }).catch(() => false)) {
      await confirm.click({ force: true }).catch(() => {});
      await page.waitForTimeout(600);
    }
    await page.goto('/');
  }

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

test.describe('online negotiation flows: undo, draw cooldown, resignation, and disconnect', () => {
  test('undo flow: mutual countdown dialog, action locking, agreement, and 1-step rollback', async ({ browser }) => {
    const hostContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const hostPage = await hostContext.newPage();
    const guestContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    let guestPage: Page | null = null;

    try {
      const room = await createRoom(hostPage);
      guestPage = await openGuest(guestContext, room.port);
      await joinRoom(guestPage, `127.0.0.1:${room.port}`);

      await startStandardMatch(hostPage, guestPage);

      // 初始步数为 0，此时“悔棋”按钮处于禁用状态（无可悔步数）
      await expect(hostPage.getByTestId('btn-undo')).toBeDisabled();
      await expect(guestPage.getByTestId('btn-undo')).toBeDisabled();

      // 红方（房主）翻开 (0, 6)（红炮）
      await hostPage.getByTestId('cell-0-6').click();
      await expect(hostPage.getByTestId('step-number')).toHaveText('第 1 步', { timeout: 5000 });
      await expect(guestPage.getByTestId('step-number')).toHaveText('第 1 步', { timeout: 5000 });
      await expect(hostPage.locator('[data-testid="cell-0-6"] .piece-text')).toHaveText('炮');

      // 红方发起悔棋申请
      await expect(hostPage.getByTestId('btn-undo')).toBeEnabled();
      await hostPage.getByTestId('btn-undo').click();

      // 双方均弹出协商对话框
      await expect(hostPage.getByTestId('negotiation-dialog')).toBeVisible({ timeout: 5000 });
      await expect(guestPage.getByTestId('negotiation-dialog')).toBeVisible({ timeout: 5000 });

      // 房主作为发起方，显示等待状态
      await expect(hostPage.locator('.negotiation-waiting-state')).toBeVisible();
      await expect(hostPage.locator('.negotiation-title')).toContainText('悔棋申请已发出');

      // 客人作为应答方，显示倒计时与同意/拒绝按钮
      await expect(guestPage.locator('.negotiation-title')).toContainText('对方申请悔棋');
      await expect(guestPage.getByTestId('negotiation-agree-btn')).toBeVisible();
      await expect(guestPage.getByTestId('negotiation-reject-btn')).toBeVisible();

      // 协商期间双方落子互斥锁定：棋盘处于 disabled 状态
      await expect(hostPage.locator('.board')).toHaveClass(/is-disabled/);
      await expect(guestPage.locator('.board')).toHaveClass(/is-disabled/);

      // 截图证据：悔棋协商中状态
      await captureEvidence(guestPage, 'negotiation-undo-dialog-1366x768.png');

      // 客人点击「同意」
      await guestPage.getByTestId('negotiation-agree-btn').click();

      // 双方弹窗自动关闭，并展示事件通知 Toast
      await expect(hostPage.getByTestId('negotiation-dialog')).toHaveCount(0, { timeout: 5000 });
      await expect(guestPage.getByTestId('negotiation-dialog')).toHaveCount(0, { timeout: 5000 });
      await expect(hostPage.getByTestId('negotiation-toast')).toBeVisible();
      await expect(guestPage.getByTestId('negotiation-toast')).toBeVisible();

      // 步数回退至第 0 步，回合重新交回红方，(0, 6) 重新盖回暗子
      await expect(hostPage.getByTestId('step-number')).toHaveText('第 0 步', { timeout: 5000 });
      await expect(guestPage.getByTestId('step-number')).toHaveText('第 0 步', { timeout: 5000 });
      await expect(hostPage.getByTestId('turn-indicator')).toContainText('轮到你（红方）');
      await expect(guestPage.getByTestId('turn-indicator')).toContainText('等待对方行动（红方）');
      await expect(hostPage.locator('[data-testid="cell-0-6"]')).toHaveAttribute('data-cell-state', 'hidden');
      await expect(hostPage.locator('[data-testid="cell-0-6"] .piece-text')).toHaveText('暗');

      // 截图证据：悔棋成功回滚
      await captureEvidence(hostPage, 'negotiation-undo-rollback-success.png');
    } finally {
      await teardownMatch(hostPage);
      await hostContext.close();
      await guestContext.close();
    }
  });

  test('draw flow: request, reject, 10s cooldown timer, and mutual agreement settlement', async ({ browser }) => {
    const hostContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const hostPage = await hostContext.newPage();
    const guestContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    let guestPage: Page | null = null;

    try {
      const room = await createRoom(hostPage);
      guestPage = await openGuest(guestContext, room.port);
      await joinRoom(guestPage, `127.0.0.1:${room.port}`);

      await startStandardMatch(hostPage, guestPage);

      // 客人点击「求和」
      await guestPage.getByTestId('btn-draw').click();

      // 房主弹窗，并点击「拒绝」
      await expect(hostPage.getByTestId('negotiation-dialog')).toBeVisible({ timeout: 5000 });
      await hostPage.getByTestId('negotiation-reject-btn').click();

      // 弹窗消失，显示拒绝 Toast
      await expect(hostPage.getByTestId('negotiation-dialog')).toHaveCount(0, { timeout: 5000 });
      await expect(guestPage.getByTestId('negotiation-toast')).toBeVisible();
      await expect(guestPage.getByTestId('negotiation-toast')).toContainText('对方拒绝了求和申请');

      // 客人求和按钮进入 10 秒冷却倒计时，按钮禁用
      await expect(guestPage.getByTestId('btn-draw')).toBeDisabled();
      await expect(guestPage.getByTestId('btn-draw')).toHaveText(/求和 \(\d+s\)/);

      // 截图证据：求和冷却中
      await captureEvidence(guestPage, 'negotiation-draw-cooldown.png');

      // 房主发起求和
      await hostPage.getByTestId('btn-draw').click();
      await expect(guestPage.getByTestId('negotiation-dialog')).toBeVisible({ timeout: 5000 });

      // 客人点击「同意」求和
      await guestPage.getByTestId('negotiation-agree-btn').click();

      // 双方进入终局结算弹窗：平局、协商和棋
      await expect(hostPage.getByTestId('game-result-modal')).toBeVisible({ timeout: 5000 });
      await expect(guestPage.getByTestId('game-result-modal')).toBeVisible({ timeout: 5000 });

      await expect(hostPage.getByTestId('result-outcome-title')).toHaveText('平局');
      await expect(guestPage.getByTestId('result-outcome-title')).toHaveText('平局');
      await expect(hostPage.getByTestId('result-reason')).toContainText('双方握手言和，协商平局');
      await expect(guestPage.getByTestId('result-reason')).toContainText('双方握手言和，协商平局');
      await expect(hostPage.getByTestId('celebration-piece')).toContainText('和');

      // 截图证据：握手言和平局弹窗
      await captureEvidence(hostPage, 'negotiation-draw-settlement-modal.png');
    } finally {
      await teardownMatch(hostPage);
      await hostContext.close();
      await guestContext.close();
    }
  });

  test('resignation flow: confirmation modal, cancellation, confirm forfeit, and multi-viewport verification', async ({
    browser,
  }) => {
    const viewports = [
      { name: '1366x768', width: 1366, height: 768 },
      { name: '1920x1080', width: 1920, height: 1080 },
      { name: '683x768', width: 683, height: 768 },
    ];

    for (const vp of viewports) {
      const hostContext = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const hostPage = await hostContext.newPage();
      const guestContext = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      let guestPage: Page | null = null;

      try {
        const room = await createRoom(hostPage);
        guestPage = await openGuest(guestContext, room.port);
        await joinRoom(guestPage, `127.0.0.1:${room.port}`);

        await startStandardMatch(hostPage, guestPage);

        // 客人点击「认输」 -> 弹出确认弹窗
        await guestPage.getByTestId('btn-resign').click();
        await expect(guestPage.getByTestId('resign-confirm-dialog')).toBeVisible();

        if (vp.name === '1366x768') {
          // 先测试取消
          await guestPage.getByTestId('cancel-resign-btn').click();
          await expect(guestPage.getByTestId('resign-confirm-dialog')).toHaveCount(0);

          // 再次点击认输
          await guestPage.getByTestId('btn-resign').click();
          await expect(guestPage.getByTestId('resign-confirm-dialog')).toBeVisible();
          await captureEvidence(guestPage, `resignation-confirm-dialog-${vp.name}.png`);
        }

        // 确认认输
        await guestPage.getByTestId('confirm-resign-btn').click();

        // 双方立即进入结算弹窗
        await expect(hostPage.getByTestId('game-result-modal')).toBeVisible({ timeout: 5000 });
        await expect(guestPage.getByTestId('game-result-modal')).toBeVisible({ timeout: 5000 });

        // 房主（红方未认输方）获胜
        await expect(hostPage.getByTestId('result-outcome-title')).toHaveText('胜利！');
        await expect(hostPage.getByTestId('result-reason')).toContainText('对方认输');

        // 客人（黑方认输方）惜败
        await expect(guestPage.getByTestId('result-outcome-title')).toHaveText('惜败');
        await expect(guestPage.getByTestId('result-reason')).toContainText('己方认输');

        // 截图证据：各视口下的认输终局弹窗
        await captureEvidence(hostPage, `resignation-winner-settlement-${vp.name}.png`);
        await captureEvidence(guestPage, `resignation-loser-settlement-${vp.name}.png`);
      } finally {
        await teardownMatch(hostPage);
        await hostContext.close();
        await guestContext.close();
      }
    }
  });

  test('disconnect during negotiation: auto-cancels negotiation and unlocks board', async ({ browser }) => {
    const hostContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const hostPage = await hostContext.newPage();
    const guestContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    let guestPage: Page | null = null;

    try {
      const room = await createRoom(hostPage);
      guestPage = await openGuest(guestContext, room.port);
      await joinRoom(guestPage, `127.0.0.1:${room.port}`);

      await startStandardMatch(hostPage, guestPage);

      // 红方翻棋
      await hostPage.getByTestId('cell-0-6').click();
      await expect(hostPage.getByTestId('step-number')).toHaveText('第 1 步', { timeout: 5000 });

      // 红方发起悔棋申请
      await hostPage.getByTestId('btn-undo').click();
      await expect(hostPage.getByTestId('negotiation-dialog')).toBeVisible({ timeout: 5000 });

      // 客人突然关闭页面/断开连接
      await guestPage.close();
      guestPage = null;

      // 房主侧协商弹层自动销毁，且接收到连接中断取消通知，棋盘解挂
      await expect(hostPage.getByTestId('negotiation-dialog')).toHaveCount(0, { timeout: 5000 });
      await expect(hostPage.getByTestId('negotiation-toast')).toBeVisible();
      await expect(hostPage.getByTestId('negotiation-toast')).toContainText('成员连接中断，协商已取消');

      // 截图证据：断线取消解挂
      await captureEvidence(hostPage, 'negotiation-disconnect-cancellation.png');
    } finally {
      await teardownMatch(hostPage);
      await hostContext.close();
      await guestContext.close();
    }
  });
});
