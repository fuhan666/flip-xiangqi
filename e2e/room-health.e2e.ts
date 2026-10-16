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
  await page.screenshot({ fullPage: true, path: path.join(EVIDENCE_DIR, `room-health-${name}.png`) });
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

async function closeRoomFromHost(hostPage: Page): Promise<void> {
  try {
    const closeBtn = hostPage.getByTestId('close-room');
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click();
      await hostPage.getByTestId('confirm-yes').click();
      await expect(hostPage.getByTestId('menu-toast')).toContainText('房间已关闭', { timeout: 10_000 }).catch(() => false);
    }
  } catch {
    // 忽略清理异常
  }
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

test.describe('heartbeat, latency monitoring and disconnection recovery', () => {
  test('displays status lamp and RTT for host and guest', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const hostErrors = watchConsole(hostPage);
    const room = await createRoom(hostPage);

    // 房主端顶部网络状态指示灯与 RTT 展示
    await expect(hostPage.getByTestId('connection-status')).toBeVisible();
    await expect(hostPage.getByTestId('connection-lamp')).toHaveClass(/connection-lamp-(green|yellow)/);
    await expect(hostPage.getByTestId('connection-rtt')).toBeVisible();
    await screenshot(hostPage, '01-host-status-lamp');

    const guestContext = await browser.newContext();
    const guestPage = await openGuest(guestContext, room.port);
    const guestErrors = watchConsole(guestPage);
    await joinRoom(guestPage, `127.0.0.1:${room.port}`);

    // 客人端加入后顶部网络状态指示灯与 RTT 展示
    await expect(guestPage.getByTestId('connection-status')).toBeVisible();
    await expect(guestPage.getByTestId('connection-lamp')).toHaveClass(/connection-lamp-green/, { timeout: 10_000 });
    await expect(guestPage.getByTestId('connection-rtt')).toContainText(/ms/, { timeout: 10_000 });
    await screenshot(guestPage, '02-guest-status-lamp');

    expect(hostErrors).toEqual([]);
    expect(guestErrors).toEqual([]);

    await closeRoomFromHost(hostPage);
    await hostContext.close();
    await guestContext.close();
  });

  test('detects silent disconnection on host side within 5000ms', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const room = await createRoom(hostPage);

    const guestContext = await browser.newContext();
    const guestPage = await openGuest(guestContext, room.port);
    await joinRoom(guestPage, `127.0.0.1:${room.port}`);

    await expect(hostPage.getByTestId('member-guest')).toContainText('在线');

    // 突发静默断线（直接关闭客人端页面与网络会话）
    const dropStart = Date.now();
    await guestContext.close();

    // 房主端必须在 5000ms 内检测到心跳失联并呈现「已掉线」
    await expect(hostPage.getByTestId('member-guest')).toContainText('已掉线', { timeout: 5000 });
    const elapsed = Date.now() - dropStart;
    expect(elapsed).toBeLessThanOrEqual(5000);

    await screenshot(hostPage, '03-host-detected-silent-drop');
    await closeRoomFromHost(hostPage);
    await hostContext.close();
  });

  test('handles disconnection with top banner, backoff, manual reconnect and toast', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const room = await createRoom(hostPage);

    const guestContext = await browser.newContext();
    const guestPage = await openGuest(guestContext, room.port);
    await joinRoom(guestPage, `127.0.0.1:${room.port}`);

    // 客人准备
    await guestPage.getByTestId('lobby-ready-toggle').click();
    await expect(guestPage.getByTestId('lobby-ready-toggle')).toHaveText('取消准备', { timeout: 10_000 });

    // 模拟网络断线：断开客人 WebSocket
    await guestPage.evaluate(() => {
      (window as any).__roomWs?.close();
    });

    // 验证断线横幅与指示灯变化
    const banner = guestPage.getByTestId('connection-banner');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText('与房间的连接已断开，正在重连…');
    await expect(guestPage.getByTestId('connection-lamp')).toHaveClass(/connection-lamp-red/);

    // 重连中大厅操作控件禁用，离开房间保留
    await expect(guestPage.getByTestId('lobby-ready-toggle')).toBeDisabled();
    await expect(guestPage.getByTestId('leave-room')).toBeEnabled();

    // 验证重连按钮触控区域 >= 44px
    const reconnectBtn = guestPage.getByTestId('reconnect-button');
    await expect(reconnectBtn).toBeVisible();
    const btnBox = await reconnectBtn.boundingBox();
    expect(btnBox).not.toBeNull();
    expect(btnBox!.height).toBeGreaterThanOrEqual(44);

    await screenshot(guestPage, '04-guest-reconnecting-banner');

    // 房主端同时更新为离线
    await expect(hostPage.getByTestId('member-guest')).toContainText('已掉线', { timeout: 10_000 });

    // 点击手动重连按钮触发重连
    await reconnectBtn.click();

    // 验证重连成功：横幅消失、呈现 3 秒轻量 toast、指示灯变绿、准备按钮重新可用
    await expect(banner).not.toBeVisible({ timeout: 10_000 });
    const toast = guestPage.getByTestId('reconnected-toast');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('已重新连接 ✓');
    await expect(guestPage.getByTestId('connection-lamp')).toHaveClass(/connection-lamp-green/, { timeout: 10_000 });
    await expect(guestPage.getByTestId('lobby-ready-toggle')).toBeEnabled();

    // 房主端看到客人重新上线
    await expect(hostPage.getByTestId('member-guest')).toContainText('在线', { timeout: 10_000 });

    await screenshot(guestPage, '05-guest-reconnected-toast');

    // 3 秒后 toast 自动消失
    await expect(toast).not.toBeVisible({ timeout: 5000 });

    await closeRoomFromHost(hostPage);
    await hostContext.close();
    await guestContext.close();
  });

  test('notifies guest and retains address when host closes room', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const room = await createRoom(hostPage);

    const guestContext = await browser.newContext();
    const guestPage = await openGuest(guestContext, room.port);
    const guestAddress = `127.0.0.1:${room.port}`;
    await joinRoom(guestPage, guestAddress);

    // 房主显式解散房间
    await hostPage.getByTestId('close-room').click();
    await hostPage.getByTestId('confirm-yes').click();
    await expect(hostPage.getByTestId('menu-toast')).toContainText('房间已关闭', { timeout: 10_000 });

    // 客人端收到解散通知并退回加入页，输入框保留原地址
    await expect(guestPage.getByTestId('room-closed-notice')).toBeVisible({ timeout: 10_000 });
    await expect(guestPage.getByTestId('room-closed-notice')).toContainText('房主已关闭房间');
    await expect(guestPage.getByTestId('join-address-input')).toHaveValue(guestAddress);
    await screenshot(guestPage, '06-guest-room-closed-notice');

    await hostContext.close();
    await guestContext.close();
  });

  test('status lamp and banner fit 1366x768, 1920x1080 and half-screen 683x768 without overflow', async ({ browser }) => {
    for (const viewport of [
      { name: '1366x768', width: 1366, height: 768 },
      { name: '1920x1080', width: 1920, height: 1080 },
      { name: 'half-683x768', width: 683, height: 768 },
    ]) {
      const hostContext = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const hostPage = await hostContext.newPage();
      const room = await createRoom(hostPage);

      const guestContext = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const guestPage = await openGuest(guestContext, room.port);
      await joinRoom(guestPage, `127.0.0.1:${room.port}`);

      // 验证指示灯可见、无水平滚动溢出
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

      // 触发断线显示横幅
      await guestPage.evaluate(() => {
        (window as any).__roomWs?.close();
      });
      await expect(guestPage.getByTestId('connection-banner')).toBeVisible({ timeout: 10_000 });

      // 验证横幅与重连按钮在不同分辨率下无横向溢出且触达正常
      const bannerOverflow = await guestPage.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(bannerOverflow.scrollWidth).toBeLessThanOrEqual(bannerOverflow.innerWidth + 1);

      await screenshot(guestPage, `07-guest-banner-${viewport.name}`);

      await closeRoomFromHost(hostPage);
      await hostContext.close();
      await guestContext.close();
    }
  });
});
