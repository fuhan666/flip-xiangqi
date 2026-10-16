import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createServer } from 'node:net';
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
  await page.screenshot({ fullPage: true, path: path.join(EVIDENCE_DIR, `room-connection-${name}.png`) });
}

async function createRoom(page: Page): Promise<RoomHandle> {
  await page.goto('/');
  await page.getByTestId('menu-create').click();
  const addressElement = page.getByTestId('room-address-main');
  await expect(addressElement).toBeVisible();
  const address = ((await addressElement.textContent()) ?? '').trim();
  expect(address).toMatch(/^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/);
  const port = Number(address.split(':').pop());
  return { address, port };
}

async function openGuest(context: BrowserContext, port: number): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByTestId('menu-join').click();
  return page;
}

async function joinRoom(page: Page, address: string): Promise<void> {
  await page.getByTestId('join-address-input').fill(address);
  await page.getByTestId('join-submit').click();
  await expect(page.getByTestId('member-host')).toBeVisible({ timeout: 10_000 });
}

test.describe('host-client room connection', () => {
  test('host creates a room, guests join from the shared address and see each other', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const hostErrors = watchConsole(hostPage);

    const room = await createRoom(hostPage);
    await expect(hostPage.getByText(/请让对手与你连接同一 Wi-Fi\/局域网/)).toBeVisible();

    // 复制按钮反馈。
    await hostContext.grantPermissions(['clipboard-read', 'clipboard-write']);
    await hostPage.getByTestId('copy-address').click();
    await expect(hostPage.getByTestId('copy-address')).toHaveText('已复制 ✓');
    await screenshot(hostPage, '01-host-waiting');

    // 客人打开房主分享的地址（真实房间服务提供的页面），加入后双方互见。
    const guestContext = await browser.newContext();
    const guestPage = await openGuest(guestContext, room.port);
    await expect(guestPage.getByTestId('join-address-input')).toHaveValue(`127.0.0.1:${room.port}`);
    await joinRoom(guestPage, `127.0.0.1:${room.port}`);

    await expect(guestPage.getByTestId('member-host')).toContainText('房主');
    await expect(guestPage.getByTestId('member-guest')).toContainText('客人');
    await expect(guestPage.getByTestId('member-host')).toContainText('在线');
    await expect(hostPage.getByTestId('member-guest')).toContainText('在线');
    await screenshot(guestPage, '02-guest-joined');
    await screenshot(hostPage, '03-host-with-guest');

    // 第三个客人：满员有明确文案。
    const thirdContext = await browser.newContext();
    const thirdPage = await openGuest(thirdContext, room.port);
    await thirdPage.getByTestId('join-submit').click();
    await expect(thirdPage.getByTestId('join-connection-error')).toContainText('房间已关闭或人数已满', { timeout: 10_000 });
    await screenshot(thirdPage, '04-guest-room-full');

    // 客人离开：房主端置灰并标注原因；席位可复用。
    await guestPage.getByTestId('leave-room').click();
    await guestPage.getByTestId('confirm-yes').click();
    await expect(guestPage.getByTestId('join-submit')).toBeVisible();
    await expect(hostPage.getByTestId('member-guest')).toContainText('已离开', { timeout: 10_000 });

    await joinRoom(thirdPage, `127.0.0.1:${room.port}`);
    await expect(thirdPage.getByTestId('member-guest')).toContainText('在线');
    await expect(hostPage.getByTestId('member-guest')).toContainText('在线', { timeout: 10_000 });

    // 最近房间：重开页面后仍在，点击即填入。
    await thirdPage.reload();
    await thirdPage.getByTestId('menu-join').click();
    await expect(thirdPage.getByTestId('recent-rooms')).toContainText(`127.0.0.1:${room.port}`);
    await thirdPage.getByTestId('recent-room-item').first().click();
    await expect(thirdPage.getByTestId('join-address-input')).toHaveValue(`127.0.0.1:${room.port}`);

    expect(hostErrors).toEqual([]);
    await hostContext.close();
    await guestContext.close();
    await thirdContext.close();
  });

  test('host closing the room notifies the guest and returns to the join page with the address', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const room = await createRoom(hostPage);

    const guestContext = await browser.newContext();
    const guestPage = await openGuest(guestContext, room.port);
    await joinRoom(guestPage, `127.0.0.1:${room.port}`);

    await hostPage.getByTestId('close-room').click();
    await expect(hostPage.getByTestId('confirm-dialog')).toBeVisible();
    await hostPage.getByTestId('confirm-yes').click();
    await expect(hostPage.getByTestId('menu-toast')).toContainText('房间已关闭', { timeout: 10_000 });

    await expect(guestPage.getByTestId('room-closed-notice')).toContainText('房主已关闭房间', { timeout: 10_000 });
    await expect(guestPage.getByTestId('join-address-input')).toHaveValue(`127.0.0.1:${room.port}`);
    await screenshot(guestPage, '05-guest-room-closed');

    await hostContext.close();
    await guestContext.close();
  });

  test('invalid and unreachable addresses produce specific actionable errors', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('/');
    await page.getByTestId('menu-join').click();

    await page.getByTestId('join-address-input').fill('192.168.1.5');
    await page.getByTestId('join-submit').click();
    await expect(page.getByTestId('join-error')).toContainText('缺少端口');

    // 端口可配置的空闲端口：连接被拒绝给出排查型提示。
    const probe = createServer();
    const freePort = await new Promise<number>((resolve) => {
      probe.listen(0, '127.0.0.1', () => {
        const port = (probe.address() as { port: number }).port;
        probe.close(() => resolve(port));
      });
    });

    await page.getByTestId('join-address-input').fill(`127.0.0.1:${freePort}`);
    await page.getByTestId('join-submit').click();
    await expect(page.getByTestId('join-connection-error')).toContainText('无法连接到房间', { timeout: 15_000 });
    await screenshot(page, '06-join-failed');

    await context.close();
  });

  test('room screens fit 1366x768, 1920x1080 and half-screen viewports with reachable buttons', async ({ browser }) => {
    for (const viewport of [
      { name: '1366x768', width: 1366, height: 768 },
      { name: '1920x1080', width: 1920, height: 1080 },
      { name: 'half-683x768', width: 683, height: 768 },
    ]) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
      const page = await context.newPage();
      await page.goto('/');

      // 主菜单无横向溢出、主按钮触达 ≥ 44px。
      const menuMetrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        buttons: Array.from(document.querySelectorAll('.menu-actions button')).map((button) => button.getBoundingClientRect().height),
      }));
      expect(menuMetrics.scrollWidth).toBeLessThanOrEqual(menuMetrics.innerWidth + 1);
      for (const height of menuMetrics.buttons) {
        expect(height).toBeGreaterThanOrEqual(44);
      }

      // 键盘焦点可见（Tab 后 :focus-visible 有描边）。
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      const focusVisible = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        if (!active || !active.matches(':focus-visible')) {
          return false;
        }
        const style = window.getComputedStyle(active);
        return style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
      });
      expect(focusVisible).toBe(true);

      await screenshot(page, `07-menu-${viewport.name}`);

      await page.getByTestId('menu-create').click();
      await expect(page.getByTestId('room-address-main')).toBeVisible();
      const roomMetrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        copyHeight: document.querySelector('.address-copy')?.getBoundingClientRect().height ?? 0,
      }));
      expect(roomMetrics.scrollWidth).toBeLessThanOrEqual(roomMetrics.innerWidth + 1);
      expect(roomMetrics.copyHeight).toBeGreaterThanOrEqual(44);
      await screenshot(page, `08-create-${viewport.name}`);

      await page.getByTestId('close-room').click();
      await page.getByTestId('confirm-yes').click();
      await expect(page.getByTestId('menu-toast')).toBeVisible();
      await context.close();
    }
  });
});
