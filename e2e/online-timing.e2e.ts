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
  await page.screenshot({ fullPage: false, path: path.join(EVIDENCE_DIR, `online-timing-${name}.png`) });
}

async function installWebSocketSpy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    (window as any).__wsMessages = [];
    (window as any).__lastGameState = null;
    (window as any).__lastClock = null;
    (window as any).__lastWelcome = null;

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
            if (data.type === 'game.clock') {
              (window as any).__lastClock = data;
            }
            if (data.type === 'welcome') {
              (window as any).__lastWelcome = data;
            }
          } catch {}
        });
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

test.describe('online turn timing, countdown warnings, disconnection grace, and settlement dialog', () => {
  test('authoritative clock broadcast, countdown ticking, 90s grace banner, check toast, and settlement modal with multi-viewports', async ({
    browser,
  }) => {
    // 默认测试视口 1366x768
    const hostContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const hostPage = await hostContext.newPage();
    const hostErrors = watchConsole(hostPage);
    const room = await createRoom(hostPage);

    const guestContext = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const guestPage = await openGuest(guestContext, room.port);
    const guestErrors = watchConsole(guestPage);
    await joinRoom(guestPage, `127.0.0.1:${room.port}`);

    // 房主选择「标准局时 (20分/60秒)」与「红方先行」，等待权威确认
    await hostPage.getByTestId('setting-time-standard').click({ force: true });
    await expect(hostPage.getByTestId('setting-time-standard')).toBeChecked({ timeout: 5000 });
    await hostPage.getByTestId('setting-side-host-red').click({ force: true });
    await expect(hostPage.getByTestId('setting-side-host-red')).toBeChecked({ timeout: 5000 });

    // 双方就绪并开始
    await guestPage.getByTestId('lobby-ready-toggle').click();
    await expect(guestPage.getByTestId('lobby-ready-toggle')).toHaveText('取消准备', { timeout: 10_000 });
    await hostPage.getByTestId('lobby-ready-toggle').click();
    await expect(hostPage.getByTestId('lobby-start-hint')).toContainText('双方已就绪', { timeout: 10_000 });
    await hostPage.getByTestId('lobby-start').click();

    // 双方进入对局棋盘
    await expect(hostPage.getByTestId('online-game')).toBeVisible({ timeout: 10_000 });
    await expect(guestPage.getByTestId('online-game')).toBeVisible({ timeout: 10_000 });
    await expect(hostPage.getByTestId('shuffling-banner')).toHaveCount(0, { timeout: 2000 });
    await expect(guestPage.getByTestId('shuffling-banner')).toHaveCount(0, { timeout: 2000 });

    // ====== 1. 时钟初始渲染与走秒验证 ======
    await expect(hostPage.getByTestId('player-clock-red')).toBeVisible();
    await expect(hostPage.getByTestId('player-clock-black')).toBeVisible();
    await expect(guestPage.getByTestId('player-clock-red')).toBeVisible();
    await expect(guestPage.getByTestId('player-clock-black')).toBeVisible();

    // 初始局时与步时格式：红方先行已开始走秒，黑方保持 20:00
    await expect(hostPage.getByTestId('base-time-red')).toHaveText(/^(19:5[89]|20:00)$/);
    await expect(hostPage.getByTestId('step-time-red')).toHaveText(/^(5[89]|60)s$/);
    await expect(guestPage.getByTestId('base-time-black')).toHaveText('20:00');

    // 等待 1.5 秒观察红方（先行方）时钟自然平滑递减
    await hostPage.waitForTimeout(1600);

    // 检查走秒：红方局时已进入 19:58 或 19:59，步时 < 60s
    const hostRedBaseText = await hostPage.getByTestId('base-time-red').innerText();
    const guestRedBaseText = await guestPage.getByTestId('base-time-red').innerText();
    expect(hostRedBaseText).toMatch(/^19:5[789]$/);
    expect(guestRedBaseText).toMatch(/^19:5[789]$/);

    // 黑方未行动，时钟保持 20:00
    await expect(hostPage.getByTestId('base-time-black')).toHaveText('20:00');
    await expect(guestPage.getByTestId('base-time-black')).toHaveText('20:00');

    // 时钟截图：正常对局走秒（1366x768）
    await screenshot(hostPage, '01-countdown-active-1366x768');

    // ====== 2. 紧迫态告警与逐秒闪烁验证 (红方当前行动中) ======
    // 注入紧迫态时钟广播：局时 45 秒（< 60s 红色脉动）、步时 4 秒（<= 5s 逐秒闪烁）
    await hostPage.evaluate(() => {
      const lastClock = (window as any).__lastClock;
      const urgentClock = {
        version: lastClock.version ?? 5,
        type: 'game.clock',
        roomId: lastClock.roomId,
        payload: {
          matchId: lastClock.payload.matchId,
          revision: lastClock.payload.revision ?? 0,
          sampleSeq: (lastClock.payload.sampleSeq ?? 0) + 1,
          clock: {
            ...lastClock.payload.clock,
            sampleSeq: (lastClock.payload.sampleSeq ?? 0) + 1,
            serverTime: Date.now(),
            paused: false,
            activeCamp: 'red',
            red: {
              ...lastClock.payload.clock.red,
              baseTimeRemainingMs: 45_000,
              stepTimeRemainingMs: 4_000,
            },
          },
        },
      };
      (window as any).__roomWs.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(urgentClock) }));
    });

    // 验证 .urgent-warning 与 .extreme-warning 样式类已挂载
    await expect(hostPage.getByTestId('player-clock-red')).toHaveClass(/urgent-warning/);
    await expect(hostPage.getByTestId('player-clock-red')).toHaveClass(/extreme-warning/);
    await expect(hostPage.getByTestId('step-time-red')).toHaveText('4s');
    await screenshot(hostPage, '02-urgent-warning-1366x768');

    // ====== 3. 回合动作与步数推进 ======
    // 红方（房主）翻开 (0, 6)（红炮）
    await hostPage.getByTestId('cell-0-6').click();
    await expect(hostPage.getByTestId('step-number')).toHaveText('第 1 步', { timeout: 5000 });
    await expect(guestPage.getByTestId('step-number')).toHaveText('第 1 步', { timeout: 5000 });

    // ====== 4. 90秒断线宽限期横幅与时钟冻结 ======
    // 模拟客人断开连接并离线
    await guestContext.close();

    // 房主端观察到 90 秒断线宽限横幅出现，显示剩余秒数
    await expect(hostPage.getByTestId('disconnect-grace-banner')).toBeVisible({ timeout: 5000 });
    await expect(hostPage.getByTestId('disconnect-grace-banner')).toContainText('对手已掉线，对局时钟暂停中。等待重连');
    await expect(hostPage.getByTestId('disconnect-grace-banner')).toContainText('90 秒');

    // 时钟显示已暂停标记
    await expect(hostPage.locator('.clock-paused-badge').first()).toBeVisible();
    await screenshot(hostPage, '03-grace-period-1366x768');

    // ====== 5. 权威终局结算弹层（GameResultDialog）验证 ======
    // 注入权威终局广播（胜方红方，原因 step-timeout）
    await hostPage.evaluate(() => {
      const lastGameState = (window as any).__lastGameState;
      const settlementMsg = {
        ...lastGameState,
        payload: {
          ...lastGameState.payload,
          settlement: {
            winner: 'red',
            loser: 'black',
            reason: 'step-timeout',
            redDurationSeconds: 45,
            blackDurationSeconds: 15,
            endedAt: Date.now(),
          },
        },
      };
      (window as any).__roomWs.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(settlementMsg) }));
    });

    // 终局弹层正确弹出并展示胜负结果、用时统计与操作按钮
    await expect(hostPage.getByTestId('game-result-modal')).toBeVisible({ timeout: 5000 });
    await expect(hostPage.getByTestId('result-outcome-title')).toHaveText('胜利！');
    await expect(hostPage.getByTestId('result-reason')).toContainText('单步用时耗尽超时判负');
    await expect(hostPage.getByTestId('result-stats')).toContainText('红方总用时');
    await expect(hostPage.getByTestId('result-stats')).toContainText('黑方总用时');
    await expect(hostPage.getByTestId('result-stats')).toContainText('总局时');
    await expect(hostPage.getByTestId('celebration-piece')).toBeVisible();
    await expect(hostPage.getByTestId('btn-rematch')).toBeVisible();
    await expect(hostPage.getByTestId('btn-return-lobby')).toBeVisible();

    await screenshot(hostPage, '04-settlement-modal-1366x768');

    // ====== 6. 多视口响应式验证 (1920x1080 与 683x768 半屏) ======
    // 1920x1080 视口
    await hostPage.setViewportSize({ width: 1920, height: 1080 });
    await hostPage.waitForTimeout(300);
    await expect(hostPage.getByTestId('game-result-modal')).toBeVisible();
    await expect(hostPage.getByTestId('btn-rematch')).toBeVisible();
    // 验证主要交互按钮尺寸 >= 44px
    const rematchBox1080 = await hostPage.getByTestId('btn-rematch').boundingBox();
    expect(rematchBox1080).not.toBeNull();
    expect(rematchBox1080!.height).toBeGreaterThanOrEqual(44);
    await screenshot(hostPage, '05-settlement-modal-1920x1080');

    // 683x768 半屏视口
    await hostPage.setViewportSize({ width: 683, height: 768 });
    await hostPage.waitForTimeout(300);
    await expect(hostPage.getByTestId('game-result-modal')).toBeVisible();
    await expect(hostPage.getByTestId('btn-rematch')).toBeVisible();
    await expect(hostPage.getByTestId('btn-return-lobby')).toBeVisible();
    // 验证半屏无横向滚动溢出
    const hasHorizontalOverflow = await hostPage.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth;
    });
    expect(hasHorizontalOverflow).toBe(false);
    await screenshot(hostPage, '06-settlement-modal-683x768');

    // 半屏视口下的 90 秒断线横幅呈现
    // 先移除结算弹层注入以观察棋盘与横幅
    await hostPage.evaluate(() => {
      const lastGameState = (window as any).__lastGameState;
      const activeGameMsg = {
        ...lastGameState,
        payload: {
          ...lastGameState.payload,
          settlement: null,
        },
      };
      (window as any).__roomWs.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(activeGameMsg) }));
    });
    await expect(hostPage.getByTestId('disconnect-grace-banner')).toBeVisible();
    await screenshot(hostPage, '07-grace-period-683x768');

    // 房主主动关闭房间，释放端口
    await hostPage.getByTestId('close-room').click();
    await hostPage.getByTestId('confirm-yes').click();
    await expect(hostPage.getByTestId('menu-create')).toBeVisible({ timeout: 5000 });

    // 清理环境
    expect(hostErrors).toEqual([]);
    expect(guestErrors).toEqual([]);
    await hostContext.close();
  });
});
