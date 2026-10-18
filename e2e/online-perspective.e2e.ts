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
  // 非 fullPage 截图以证明真实视口内的布局效果
  await page.screenshot({ fullPage: false, path: path.join(EVIDENCE_DIR, `online-perspective-${name}.png`) });
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

test.describe('online perspective adaptive rendering & coordinate mapping', () => {
  test('Host-Red & Guest-Black: each side sees own side at bottom, upright texts, and synchronized logical coordinates', async ({
    browser,
  }) => {
    const hostContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const hostPage = await hostContext.newPage();
    const hostErrors = watchConsole(hostPage);
    const room = await createRoom(hostPage);

    const guestContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const guestPage = await openGuest(guestContext, room.port);
    const guestErrors = watchConsole(guestPage);
    await joinRoom(guestPage, `127.0.0.1:${room.port}`);

    // 房主选择 host-red
    await hostPage.getByTestId('setting-side-host-red').click({ force: true });
    await guestPage.getByTestId('lobby-ready-toggle').click();
    await expect(guestPage.getByTestId('lobby-ready-toggle')).toHaveText('取消准备', { timeout: 10_000 });
    await hostPage.getByTestId('lobby-ready-toggle').click();
    await expect(hostPage.getByTestId('lobby-start-hint')).toContainText('双方已就绪', { timeout: 10_000 });

    // 房主开局
    await hostPage.getByTestId('lobby-start').click();

    // 双方进入对局棋盘
    await expect(hostPage.getByTestId('online-game')).toBeVisible({ timeout: 10_000 });
    await expect(guestPage.getByTestId('online-game')).toBeVisible({ timeout: 10_000 });
    await expect(hostPage.getByTestId('shuffling-banner')).toHaveCount(0, { timeout: 2000 });
    await expect(guestPage.getByTestId('shuffling-banner')).toHaveCount(0, { timeout: 2000 });

    // 1. 验证视角属性
    await expect(hostPage.locator('.board')).toHaveAttribute('data-perspective', 'red');
    await expect(guestPage.locator('.board')).toHaveAttribute('data-perspective', 'black');

    // 2. 验证红方房主端「红在下、黑在上」
    const hostRedKingBox = await hostPage.getByTestId('cell-4-9').boundingBox();
    const hostBlackKingBox = await hostPage.getByTestId('cell-4-0').boundingBox();
    expect(hostRedKingBox).not.toBeNull();
    expect(hostBlackKingBox).not.toBeNull();
    // 红帅在屏幕下半部（Y 更大），黑将在屏幕上半部（Y 更小）
    expect(hostRedKingBox!.y).toBeGreaterThan(hostBlackKingBox!.y);

    // 3. 验证黑方客人员工「黑在下、红在上」
    const guestRedKingBox = await guestPage.getByTestId('cell-4-9').boundingBox();
    const guestBlackKingBox = await guestPage.getByTestId('cell-4-0').boundingBox();
    expect(guestRedKingBox).not.toBeNull();
    expect(guestBlackKingBox).not.toBeNull();
    // 黑将在屏幕下半部（Y 更大），红帅在屏幕上半部（Y 更小）
    expect(guestBlackKingBox!.y).toBeGreaterThan(guestRedKingBox!.y);

    // 4. 验证楚河汉界左右位置与正向文本
    const hostRiverLeft = await hostPage.locator('.board-artwork-river text').first().boundingBox();
    const hostRiverRight = await hostPage.locator('.board-artwork-river text').last().boundingBox();
    expect(hostRiverLeft!.x).toBeLessThan(hostRiverRight!.x);
    await expect(hostPage.locator('.board-artwork-river text').first()).toHaveText('楚河');
    await expect(hostPage.locator('.board-artwork-river text').last()).toHaveText('汉界');

    const guestRiverFirst = await guestPage.locator('.board-artwork-river text').first().boundingBox();
    const guestRiverSecond = await guestPage.locator('.board-artwork-river text').last().boundingBox();
    // 黑方视角：汉界在左 (x=225)，楚河在右 (x=675)
    await expect(guestPage.locator('.board-artwork-river text').first()).toHaveText('楚河');
    await expect(guestPage.locator('.board-artwork-river text').first()).toHaveAttribute('x', '675');
    await expect(guestPage.locator('.board-artwork-river text').last()).toHaveText('汉界');
    await expect(guestPage.locator('.board-artwork-river text').last()).toHaveAttribute('x', '225');

    // 5. 验证上下信息条内容与回合泛金光
    // 房主端：自己执红回合开始，泛金光 (turn-active)
    await expect(hostPage.getByTestId('online-self-bar')).toHaveClass(/turn-active/);
    await expect(hostPage.getByTestId('turn-indicator')).toHaveText('轮到你（红方）');
    await expect(hostPage.getByTestId('member-host')).toContainText('房主');
    await expect(hostPage.getByTestId('member-host')).toContainText('执红方');
    await expect(hostPage.getByTestId('online-opponent-bar')).toContainText('客人');
    await expect(hostPage.getByTestId('online-opponent-bar')).toContainText('执黑方');

    // 客人员端：等待对方行动，置灰 (turn-waiting)
    await expect(guestPage.getByTestId('online-self-bar')).toHaveClass(/turn-waiting/);
    await expect(guestPage.getByTestId('turn-indicator')).toHaveText('等待对方行动（红方）');
    await expect(guestPage.getByTestId('member-guest')).toContainText('客人');
    await expect(guestPage.getByTestId('member-guest')).toContainText('执黑方');
    await expect(guestPage.getByTestId('online-opponent-bar')).toContainText('房主');
    await expect(guestPage.getByTestId('online-opponent-bar')).toContainText('执红方');

    // 收集开局双端对比截图
    await screenshot(hostPage, '01-host-red-perspective');
    await screenshot(guestPage, '02-guest-black-perspective');

    // 6. 房主执行翻牌动作（红方操作逻辑暗子 (0, 6)）
    await hostPage.getByTestId('cell-0-6').click();
    await expect(hostPage.getByTestId('step-number')).toHaveText('第 1 步', { timeout: 5000 });
    await expect(guestPage.getByTestId('step-number')).toHaveText('第 1 步', { timeout: 5000 });

    // 验证两端 90 格逻辑状态完全一致
    const hostGrid = await getBoardGrid(hostPage);
    const guestGrid = await getBoardGrid(guestPage);
    expect(hostGrid).toEqual(guestGrid);

    // 回合切换：现在轮到客人（黑方），客人端泛金光
    await expect(guestPage.getByTestId('online-self-bar')).toHaveClass(/turn-active/);
    await expect(hostPage.getByTestId('online-self-bar')).toHaveClass(/turn-waiting/);

    // 截图记录翻牌动作后的双端状态
    await screenshot(hostPage, '03-after-first-move-host');
    await screenshot(guestPage, '04-after-first-move-guest');

    // 清理房间
    await hostPage.getByTestId('close-room').click();
    await hostPage.getByTestId('confirm-yes').click();
    await expect(hostPage.getByTestId('menu-create')).toBeVisible({ timeout: 5000 });

    expect(hostErrors).toEqual([]);
    expect(guestErrors).toEqual([]);

    await hostContext.close();
    await guestContext.close();
  });

  test('Host-Black & Guest-Red: verifies opposite seat configuration places Black at bottom on host', async ({
    browser,
  }) => {
    const hostContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const hostPage = await hostContext.newPage();
    const hostErrors = watchConsole(hostPage);
    const room = await createRoom(hostPage);

    const guestContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const guestPage = await openGuest(guestContext, room.port);
    const guestErrors = watchConsole(guestPage);
    await joinRoom(guestPage, `127.0.0.1:${room.port}`);

    // 房主选择 host-black（房主执黑，客人执红）
    await hostPage.getByTestId('setting-side-host-black').click({ force: true });
    await guestPage.getByTestId('lobby-ready-toggle').click();
    await expect(guestPage.getByTestId('lobby-ready-toggle')).toHaveText('取消准备', { timeout: 10_000 });
    await hostPage.getByTestId('lobby-ready-toggle').click();
    await expect(hostPage.getByTestId('lobby-start-hint')).toContainText('双方已就绪', { timeout: 10_000 });

    // 开局
    await hostPage.getByTestId('lobby-start').click();

    await expect(hostPage.getByTestId('online-game')).toBeVisible({ timeout: 10_000 });
    await expect(guestPage.getByTestId('online-game')).toBeVisible({ timeout: 10_000 });
    await expect(hostPage.getByTestId('shuffling-banner')).toHaveCount(0, { timeout: 2000 });
    await expect(guestPage.getByTestId('shuffling-banner')).toHaveCount(0, { timeout: 2000 });

    // 房主视角为黑方，客人视角为红方
    await expect(hostPage.locator('.board')).toHaveAttribute('data-perspective', 'black');
    await expect(guestPage.locator('.board')).toHaveAttribute('data-perspective', 'red');

    // 房主端：黑将在下（Y 大于红帅）
    const hostRedKingBox = await hostPage.getByTestId('cell-4-9').boundingBox();
    const hostBlackKingBox = await hostPage.getByTestId('cell-4-0').boundingBox();
    expect(hostBlackKingBox!.y).toBeGreaterThan(hostRedKingBox!.y);

    // 客人端：红帅在下（Y 大于黑将）
    const guestRedKingBox = await guestPage.getByTestId('cell-4-9').boundingBox();
    const guestBlackKingBox = await guestPage.getByTestId('cell-4-0').boundingBox();
    expect(guestRedKingBox!.y).toBeGreaterThan(guestBlackKingBox!.y);

    // 收集 host-black 截图
    await screenshot(hostPage, '05-host-black-perspective');
    await screenshot(guestPage, '06-guest-red-perspective');

    await hostPage.getByTestId('close-room').click();
    await hostPage.getByTestId('confirm-yes').click();
    await expect(hostPage.getByTestId('menu-create')).toBeVisible({ timeout: 5000 });

    expect(hostErrors).toEqual([]);
    expect(guestErrors).toEqual([]);

    await hostContext.close();
    await guestContext.close();
  });

  test('multi-viewport validation: 1366x768, 1920x1080, and 683x768 split screen with no horizontal overflow and touch targets >= 44px', async ({
    browser,
  }) => {
    const viewports = [
      { name: '1366x768', width: 1366, height: 768 },
      { name: '1920x1080', width: 1920, height: 1080 },
      { name: '683x768', width: 683, height: 768 },
    ];

    for (const vp of viewports) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await context.newPage();
      const errors = watchConsole(page);
      const room = await createRoom(page);

      const guestContext = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const guestPage = await openGuest(guestContext, room.port);
      await joinRoom(guestPage, `127.0.0.1:${room.port}`);

      await hostPageLobbyAndStart(page, guestPage);

      // 验证无水平溢出 (scrollWidth <= innerWidth + 1)
      const hasHorizontalScroll = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth + 1;
      });
      expect(hasHorizontalScroll).toBe(false);

      // 验证所有 90 个格子宽度与高度 >= 44px
      const cellSizes = await page.evaluate(() => {
        const cells = Array.from(document.querySelectorAll('.cell'));
        return cells.map((cell) => {
          const rect = cell.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        });
      });
      expect(cellSizes.length).toBe(90);
      for (const size of cellSizes) {
        expect(size.width).toBeGreaterThanOrEqual(44);
        expect(size.height).toBeGreaterThanOrEqual(44);
      }

      // 验证核心组件在视口内可见
      await expect(page.getByTestId('online-opponent-bar')).toBeVisible();
      await expect(page.locator('.board-frame')).toBeVisible();
      await expect(page.getByTestId('online-self-bar')).toBeVisible();
      await expect(page.getByTestId('close-room')).toBeVisible();

      // 验证主要操作触控区域 >= 44px
      const exitBtnBox = await page.getByTestId('close-room').boundingBox();
      expect(exitBtnBox).not.toBeNull();
      expect(exitBtnBox!.height).toBeGreaterThanOrEqual(44);
      expect(exitBtnBox!.width).toBeGreaterThanOrEqual(44);

      // 截图记录各视口呈现
      await screenshot(page, `viewport-${vp.name}`);

      await page.getByTestId('close-room').click();
      await page.getByTestId('confirm-yes').click();
      await expect(page.getByTestId('menu-create')).toBeVisible({ timeout: 5000 });

      expect(errors).toEqual([]);

      await context.close();
      await guestContext.close();
    }
  });
});

async function hostPageLobbyAndStart(hostPage: Page, guestPage: Page): Promise<void> {
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
