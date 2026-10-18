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
  await page.screenshot({ fullPage: true, path: path.join(EVIDENCE_DIR, `room-release-${name}.png`) });
}

async function createRoom(page: Page): Promise<RoomHandle> {
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
        (window as any).__lastWs = this;
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

test.describe('v0.7.0 release end-to-end full regression', () => {
  test('runs complete flow: create -> join -> sync settings -> clear ready on change -> block unready start -> pre-start reconnect -> dual ready -> start game -> post-start reconnect with frozen snapshot -> host close', async ({ browser }) => {
    // 1. 初始化双浏览器上下文（房主与客人端）
    const hostContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const hostPage = await hostContext.newPage();
    const hostErrors = watchConsole(hostPage);

    // 2. 房主建房并获取分享地址
    const room = await createRoom(hostPage);
    expect(room.port).toBeGreaterThan(0);

    // 3. 客人通过分享地址加入房间
    const guestContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const guestPage = await openGuest(guestContext, room.port);
    const guestErrors = watchConsole(guestPage);
    await joinRoom(guestPage, `127.0.0.1:${room.port}`);

    // 双端均能互见对方
    await expect(hostPage.getByTestId('member-guest')).toContainText('在线', { timeout: 10_000 });
    await expect(guestPage.getByTestId('member-host')).toContainText('在线', { timeout: 10_000 });
    await screenshot(hostPage, '01-dual-connected-host');
    await screenshot(guestPage, '02-dual-connected-guest');

    // 4. 房主更改非默认分先（房主执红）与局时（标准局 20 分 + 60 秒）
    await hostPage.getByTestId('setting-side-host-red').click({ force: true });
    await hostPage.getByTestId('setting-time-standard').click({ force: true });

    // 客人端实时同步非默认设置
    await expect(guestPage.getByTestId('setting-side-host-red')).toBeChecked({ timeout: 10_000 });
    await expect(guestPage.getByTestId('setting-time-standard')).toBeChecked({ timeout: 10_000 });
    await expect(guestPage.getByTestId('side-summary')).toContainText('房主：红方 · 客人：黑方');
    await expect(guestPage.getByTestId('member-side-guest')).toHaveText('黑方');

    // 5. 客人准备就绪；房主调整设置（或锁定/解锁），双方就绪状态自动清除
    await guestPage.getByTestId('lobby-ready-toggle').click();
    await expect(hostPage.getByTestId('member-ready-guest')).toHaveText('已准备', { timeout: 10_000 });

    // 房主锁定设置 -> 解锁设置，就绪被清空
    await hostPage.getByTestId('settings-lock').click();
    await expect(hostPage.getByTestId('settings-locked-note')).toBeVisible({ timeout: 10_000 });
    await hostPage.getByTestId('settings-lock').click(); // 解锁
    await expect(hostPage.getByTestId('member-ready-guest')).toHaveText('未准备', { timeout: 10_000 });
    await expect(guestPage.getByTestId('member-ready-guest')).toHaveText('未准备', { timeout: 10_000 });

    // 6. 房主未双方就绪时尝试开始对局，被明确拒绝
    await hostPage.getByTestId('lobby-start').click();
    await expect(hostPage.getByTestId('lobby-notice')).toContainText('等待双方准备', { timeout: 10_000 });
    await expect(hostPage.getByTestId('lobby-started')).toHaveCount(0);

    // 7. 开局前客人端模拟断线并自动/手动恢复
    await guestPage.evaluate(() => {
      (window as any).__roomWs?.close();
    });
    // 客人端出现断线横幅，准备按钮禁用，离开按钮保留
    const banner = guestPage.getByTestId('connection-banner');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(guestPage.getByTestId('lobby-ready-toggle')).toBeDisabled();
    await expect(guestPage.getByTestId('leave-room')).toBeEnabled();

    // 房主端显示客人已掉线
    await expect(hostPage.getByTestId('member-guest')).toContainText('已掉线', { timeout: 10_000 });
    await screenshot(guestPage, '03-pre-start-disconnect-banner');

    // 点击手动重连按钮（若未被 500ms 自动重连抢先完成）或等待自动重连完成
    const reconnectBtn = guestPage.getByTestId('reconnect-button');
    if (await reconnectBtn.isVisible().catch(() => false)) {
      await reconnectBtn.click().catch(() => false);
    }
    await expect(banner).not.toBeVisible({ timeout: 10_000 });
    await expect(guestPage.getByTestId('lobby-ready-toggle')).toBeEnabled({ timeout: 10_000 });
    await expect(hostPage.getByTestId('member-guest')).toContainText('在线', { timeout: 10_000 });

    // 开局前断线重连后就绪状态保持未准备（安全门禁）
    await expect(guestPage.getByTestId('member-ready-guest')).toHaveText('未准备');

    // 8. 双方重新就绪并开始对局
    await guestPage.getByTestId('lobby-ready-toggle').click();
    await expect(hostPage.getByTestId('member-ready-guest')).toHaveText('已准备', { timeout: 10_000 });
    await hostPage.getByTestId('lobby-ready-toggle').click();
    await expect(hostPage.getByTestId('lobby-start-hint')).toContainText('双方已就绪', { timeout: 10_000 });

    // 房主点击开局
    await hostPage.getByTestId('lobby-start').click();
    await expect(hostPage.getByTestId('lobby-started')).toBeVisible({ timeout: 10_000 });
    await expect(guestPage.getByTestId('lobby-started')).toBeVisible({ timeout: 10_000 });

    // 9. 核对开局快照在双端逐字一致且冻结
    const hostSnapshot = ((await hostPage.getByTestId('start-snapshot').textContent()) ?? '').trim();
    const guestSnapshot = ((await guestPage.getByTestId('start-snapshot').textContent()) ?? '').trim();
    expect(hostSnapshot).toBe(guestSnapshot);
    expect(hostSnapshot).toContain('房主执红 · 客人执黑');
    expect(hostSnapshot).toContain('20 分 + 60 秒');
    expect(hostSnapshot).toContain('设置版本 v3');
    await screenshot(hostPage, '04-game-started-host');
    await screenshot(guestPage, '05-game-started-guest');

    // 10. 开局后客人再次断线，自动重连恢复在线，验证席位与开局快照完全保持（无重复抽签、无重复客人）
    await guestPage.evaluate(() => {
      (window as any).__roomWs?.close();
    });
    // 等待自动重连完成（500ms 退避自动重连）
    await expect(hostPage.getByTestId('member-guest')).toContainText('在线', { timeout: 10_000 });
    await expect(banner).not.toBeVisible({ timeout: 10_000 });

    // 快照保持完全一致
    const guestSnapshotAfterReconnect = ((await guestPage.getByTestId('start-snapshot').textContent()) ?? '').trim();
    expect(guestSnapshotAfterReconnect).toBe(hostSnapshot);

    // 11. 房主主动解散房间，客人端感知并平滑退回
    await hostPage.getByTestId('close-room').click();
    await hostPage.getByTestId('confirm-yes').click();
    await expect(hostPage.getByTestId('menu-toast')).toContainText('房间已关闭', { timeout: 10_000 });

    await expect(guestPage.getByTestId('room-closed-notice')).toBeVisible({ timeout: 10_000 });
    await expect(guestPage.getByTestId('room-closed-notice')).toContainText('房主已关闭房间');
    await expect(guestPage.getByTestId('join-address-input')).toHaveValue(`127.0.0.1:${room.port}`);
    await screenshot(guestPage, '06-room-closed-guest');

    expect(hostErrors).toEqual([]);
    expect(guestErrors).toEqual([]);

    await hostContext.close();
    await guestContext.close();
  });

  test('multi-viewport layout consistency: 1366x768, 1920x1080 and half-screen 683x768 without horizontal overflow', async ({ browser }) => {
    const viewports = [
      { name: '1366x768', width: 1366, height: 768 },
      { name: '1920x1080', width: 1920, height: 1080 },
      { name: 'half-683x768', width: 683, height: 768 },
    ];

    for (const vp of viewports) {
      const hostContext = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const hostPage = await hostContext.newPage();
      const room = await createRoom(hostPage);

      const guestContext = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const guestPage = await openGuest(guestContext, room.port);
      await joinRoom(guestPage, `127.0.0.1:${room.port}`);

      // 验证无水平溢出
      const hostOverflow = await hostPage.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(hostOverflow.scrollWidth).toBeLessThanOrEqual(hostOverflow.innerWidth + 1);

      const guestOverflow = await guestPage.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(guestOverflow.scrollWidth).toBeLessThanOrEqual(guestOverflow.innerWidth + 1);

      await screenshot(hostPage, `07-viewport-host-${vp.name}`);
      await screenshot(guestPage, `08-viewport-guest-${vp.name}`);

      await hostPage.getByTestId('close-room').click();
      await hostPage.getByTestId('confirm-yes').click();
      await hostContext.close();
      await guestContext.close();
    }
  });
});
