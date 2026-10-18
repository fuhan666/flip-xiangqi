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
  await page.screenshot({ fullPage: true, path: path.join(EVIDENCE_DIR, `room-lobby-${name}.png`) });
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
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByTestId('menu-join').click();
  return page;
}

async function joinRoom(page: Page, address: string): Promise<void> {
  await page.getByTestId('join-address-input').fill(address);
  await page.getByTestId('join-submit').click();
  await expect(page.getByTestId('lobby-ready-toggle')).toBeVisible({ timeout: 10_000 });
}

test.describe('room lobby settings, ready gate and start snapshot', () => {
  test('settings sync to both ends, the guest stays read-only and the start gate holds until both are ready', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const hostErrors = watchConsole(hostPage);
    const room = await createRoom(hostPage);

    const guestContext = await browser.newContext();
    const guestPage = await openGuest(guestContext, room.port);
    const guestErrors = watchConsole(guestPage);
    await joinRoom(guestPage, `127.0.0.1:${room.port}`);

    // 随机分先在开局前显示「待开局确定」，局时默认不计时。
    await expect(hostPage.getByTestId('side-summary')).toContainText('待开局确定');
    await expect(hostPage.getByTestId('member-side-host')).toHaveText('待开局确定');
    await expect(hostPage.getByTestId('setting-time-none')).toBeChecked();

    // 客人端只读：设置由房主决定，无锁定与开始入口。
    await expect(guestPage.getByTestId('settings-readonly-note')).toBeVisible();
    await expect(guestPage.getByTestId('setting-side-host-red')).toBeDisabled();
    await expect(guestPage.getByTestId('setting-time-none')).toBeDisabled();
    await expect(guestPage.getByTestId('settings-lock')).toHaveCount(0);
    await expect(guestPage.getByTestId('lobby-start')).toHaveCount(0);

    // 房主改分先与局时：两端实时同步并立即呈现最终分配。
    await hostPage.getByTestId('setting-side-host-red').click({ force: true });
    await expect(hostPage.getByTestId('side-summary')).toContainText('房主：红方 · 客人：黑方');
    await expect(guestPage.getByTestId('side-summary')).toContainText('房主：红方 · 客人：黑方', { timeout: 10_000 });
    await expect(guestPage.getByTestId('setting-side-host-red')).toBeChecked({ timeout: 10_000 });

    await hostPage.getByTestId('setting-time-standard').click({ force: true });
    await expect(guestPage.getByTestId('setting-time-standard')).toBeChecked({ timeout: 10_000 });
    await expect(guestPage.getByTestId('member-side-guest')).toHaveText('黑方');

    // 客人先准备；房主未准备时开始被阻止并给出提示。
    await guestPage.getByTestId('lobby-ready-toggle').click();
    await expect(guestPage.getByTestId('lobby-ready-toggle')).toHaveText('取消准备', { timeout: 10_000 });
    await expect(hostPage.getByTestId('member-ready-guest')).toHaveText('已准备', { timeout: 10_000 });
    await expect(hostPage.getByTestId('lobby-start-hint')).toHaveText('等待双方准备');

    await hostPage.getByTestId('lobby-start').click();
    await expect(hostPage.getByTestId('lobby-notice')).toContainText('等待双方准备', { timeout: 10_000 });
    await expect(guestPage.getByTestId('lobby-started')).toHaveCount(0);
    await screenshot(hostPage, '01-host-blocked-start');
    await screenshot(guestPage, '02-guest-lobby');

    // 双方就绪后金色「开始对局」出现，开始成功两端同时呈现归属。
    await hostPage.getByTestId('lobby-ready-toggle').click();
    await expect(hostPage.getByTestId('lobby-start-hint')).toContainText('双方已就绪', { timeout: 10_000 });
    await expect(hostPage.getByTestId('lobby-start')).toHaveClass(/panel-action-gold/);
    await hostPage.getByTestId('lobby-start').click();

    await expect(hostPage.getByTestId('lobby-started')).toContainText('你执红，对手执黑 · 局时 20 分 + 60 秒（标准局）', {
      timeout: 10_000,
    });
    await expect(guestPage.getByTestId('lobby-started')).toContainText('你执黑，对手执红 · 局时 20 分 + 60 秒（标准局）', {
      timeout: 10_000,
    });

    // 开局参数快照两端逐字一致并可验证。
    const hostSnapshot = ((await hostPage.getByTestId('start-snapshot').textContent()) ?? '').trim();
    const guestSnapshot = ((await guestPage.getByTestId('start-snapshot').textContent()) ?? '').trim();
    expect(hostSnapshot).toBe(guestSnapshot);
    expect(hostSnapshot).toContain('设置版本 v3');
    expect(hostSnapshot).toContain('房主执红 · 客人执黑');
    await screenshot(hostPage, '03-host-started');
    await screenshot(guestPage, '04-guest-started');

    // 开局后进入棋盘：就绪/开始入口消失，双方棋盘可见并呈现步数。
    await expect(hostPage.getByTestId('lobby-ready-toggle')).toHaveCount(0);
    await expect(hostPage.getByTestId('lobby-start')).toHaveCount(0);
    await expect(hostPage.getByTestId('settings-lock')).toHaveCount(0);
    await expect(hostPage.getByTestId('online-game')).toBeVisible({ timeout: 10_000 });
    await expect(guestPage.getByTestId('online-game')).toBeVisible({ timeout: 10_000 });

    expect(hostErrors).toEqual([]);
    expect(guestErrors).toEqual([]);
    await hostContext.close();
    await guestContext.close();
  });

  test('changing settings clears both ready lamps and unlocking resets them too', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const room = await createRoom(hostPage);

    const guestContext = await browser.newContext();
    const guestPage = await openGuest(guestContext, room.port);
    await joinRoom(guestPage, `127.0.0.1:${room.port}`);

    await hostPage.getByTestId('lobby-ready-toggle').click();
    await guestPage.getByTestId('lobby-ready-toggle').click();
    await expect(hostPage.getByTestId('member-ready-host')).toHaveText('已准备', { timeout: 10_000 });
    await expect(hostPage.getByTestId('member-ready-guest')).toHaveText('已准备', { timeout: 10_000 });

    // 改设置：两端就绪灯同时熄灭。
    await hostPage.getByTestId('setting-side-host-black').click({ force: true });
    await expect(hostPage.getByTestId('member-ready-host')).toHaveText('未准备', { timeout: 10_000 });
    await expect(hostPage.getByTestId('member-ready-guest')).toHaveText('未准备', { timeout: 10_000 });
    await expect(guestPage.getByTestId('member-ready-host')).toHaveText('未准备', { timeout: 10_000 });

    // 锁定后设置冻结并可解锁；解锁同样清空双方就绪。
    await hostPage.getByTestId('lobby-ready-toggle').click();
    await guestPage.getByTestId('lobby-ready-toggle').click();
    await expect(guestPage.getByTestId('member-ready-guest')).toHaveText('已准备', { timeout: 10_000 });

    await hostPage.getByTestId('settings-lock').click();
    await expect(hostPage.getByTestId('settings-locked-note')).toBeVisible({ timeout: 10_000 });
    await expect(guestPage.getByTestId('settings-readonly-note')).toBeVisible();
    // 锁定后设置输入禁用，两端仍显示同一份最终分配。
    await expect(hostPage.getByTestId('setting-side-host-red')).toBeDisabled();
    await expect(guestPage.getByTestId('side-summary')).toContainText('房主：黑方', { timeout: 10_000 });

    await hostPage.getByTestId('settings-lock').click();
    await expect(hostPage.getByTestId('settings-locked-note')).toHaveCount(0);
    await expect(hostPage.getByTestId('member-ready-host')).toHaveText('未准备', { timeout: 10_000 });
    await expect(guestPage.getByTestId('member-ready-guest')).toHaveText('未准备', { timeout: 10_000 });

    await hostContext.close();
    await guestContext.close();
  });

  test('a leaving or dropping guest clears ready and explains the reason', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const room = await createRoom(hostPage);

    // 主动离开：卡片标注「已离开」，就绪清空。
    const leavingContext = await browser.newContext();
    const leavingPage = await openGuest(leavingContext, room.port);
    await joinRoom(leavingPage, `127.0.0.1:${room.port}`);
    await leavingPage.getByTestId('lobby-ready-toggle').click();
    await hostPage.getByTestId('lobby-ready-toggle').click();
    await expect(hostPage.getByTestId('member-ready-guest')).toHaveText('已准备', { timeout: 10_000 });

    await leavingPage.getByTestId('leave-room').click();
    await leavingPage.getByTestId('confirm-yes').click();
    await expect(hostPage.getByTestId('member-guest')).toContainText('已离开', { timeout: 10_000 });
    await expect(hostPage.getByTestId('member-ready-guest')).toHaveText('未准备');
    await expect(hostPage.getByTestId('member-ready-host')).toHaveText('未准备');
    await leavingContext.close();

    // 掉线：卡片标注「已掉线」，就绪同样清空，门禁保持。
    const droppingContext = await browser.newContext();
    const droppingPage = await openGuest(droppingContext, room.port);
    await joinRoom(droppingPage, `127.0.0.1:${room.port}`);
    await droppingPage.getByTestId('lobby-ready-toggle').click();
    await expect(hostPage.getByTestId('member-ready-guest')).toHaveText('已准备', { timeout: 10_000 });

    await droppingContext.close();
    await expect(hostPage.getByTestId('member-guest')).toContainText('已掉线', { timeout: 10_000 });
    await expect(hostPage.getByTestId('member-ready-guest')).toHaveText('未准备');
    await expect(hostPage.getByTestId('lobby-start-hint')).toHaveText('等待双方准备');

    await hostContext.close();
  });

  test('lobby screens fit 1366x768, 1920x1080 and half-screen viewports with reachable controls', async ({ browser }) => {
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

      // 无横向溢出；设置卡片与主要按钮触达 ≥ 44px。
      const metrics = await hostPage.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        options: Array.from(document.querySelectorAll('.setting-option')).map((option) => option.getBoundingClientRect().height),
        buttons: Array.from(document.querySelectorAll('.panel-actions button')).map((button) => button.getBoundingClientRect().height),
      }));
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
      for (const height of metrics.options) {
        expect(height).toBeGreaterThanOrEqual(44);
      }
      for (const height of metrics.buttons) {
        expect(height).toBeGreaterThanOrEqual(44);
      }

      // 半屏时操作区可达：滚动到位后按钮完整可见（不被裁切）。
      await hostPage.getByTestId('lobby-ready-toggle').scrollIntoViewIfNeeded();
      const readyBox = await hostPage.getByTestId('lobby-ready-toggle').boundingBox();
      expect(readyBox).not.toBeNull();
      expect(readyBox!.width).toBeGreaterThan(0);
      expect(readyBox!.height).toBeGreaterThanOrEqual(44);

      // 键盘可达：Tab 顺序到达操作区、焦点态有描边、Enter 可触发准备。
      let reached = false;
      for (let i = 0; i < 16 && !reached; i += 1) {
        await hostPage.keyboard.press('Tab');
        reached = await hostPage.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'lobby-ready-toggle');
      }
      expect(reached).toBe(true);
      const focusVisible = await hostPage.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        if (!active || !active.matches(':focus-visible')) {
          return false;
        }
        const style = window.getComputedStyle(active);
        return style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
      });
      expect(focusVisible).toBe(true);
      await hostPage.keyboard.press('Enter');
      await expect(hostPage.getByTestId('lobby-ready-toggle')).toHaveText('取消准备', { timeout: 10_000 });

      await screenshot(hostPage, `05-host-${viewport.name}`);
      await screenshot(guestPage, `06-guest-${viewport.name}`);

      // 开局确认同样无溢出、可读（房主已用键盘准备）。
      await guestPage.getByTestId('lobby-ready-toggle').click();
      await expect(hostPage.getByTestId('lobby-start')).toHaveClass(/panel-action-gold/, { timeout: 10_000 });
      await hostPage.getByTestId('lobby-start').click();
      await expect(hostPage.getByTestId('lobby-started')).toBeVisible({ timeout: 10_000 });
      const startedOverflow = await hostPage.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(startedOverflow.scrollWidth).toBeLessThanOrEqual(startedOverflow.innerWidth + 1);
      await screenshot(hostPage, `07-host-started-${viewport.name}`);
      await screenshot(guestPage, `08-guest-started-${viewport.name}`);

      await hostContext.close();
      await guestContext.close();
    }
  });
});
