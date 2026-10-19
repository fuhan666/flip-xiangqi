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
  await page.screenshot({ fullPage: true, path: path.join(EVIDENCE_DIR, `online-spectator-${name}.png`) });
}

async function installWebSocketSpy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    (window as any).__wsMessages ??= [];
    (window as any).__wsSent ??= [];
    (window as any).__clockBySeq ??= {};
    (window as any).__lastGameState = null;
    (window as any).__lastWelcome = null;
    (window as any).__lastGameRejected = null;
    (window as any).__lastLobbyRejected = null;
    (window as any).__lastPhraseRejected = null;

    window.WebSocket = class extends OrigWS {
      constructor(...args: any[]) {
        if ((window as any).__blockWs) {
          throw new Error('network blocked by test');
        }
        super(...(args as [string, ...any[]]));
        (window as any).__roomWs = this;

        this.addEventListener('message', (event) => {
          try {
            const data = JSON.parse(event.data);
            (window as any).__wsMessages.push(data);
            if (data.type === 'game.state') {
              (window as any).__lastGameState = data;
            }
            if (data.type === 'welcome') {
              (window as any).__lastWelcome = data;
            }
            if (data.type === 'game.rejected') {
              (window as any).__lastGameRejected = data;
            }
            if (data.type === 'lobby.rejected') {
              (window as any).__lastLobbyRejected = data;
            }
            if (data.type === 'chat.phrase.rejected') {
              (window as any).__lastPhraseRejected = data;
            }
            if (data.type === 'game.clock' && typeof data.payload?.sampleSeq === 'number') {
              (window as any).__clockBySeq[data.payload.sampleSeq] = data;
            }
          } catch {}
        });

        const origSend = this.send.bind(this);
        this.send = (data: any) => {
          try {
            (window as any).__wsSent.push(typeof data === 'string' ? JSON.parse(data) : data);
          } catch {}
          return origSend(data);
        };
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

async function readyAndStart(hostPage: Page, guestPage: Page): Promise<void> {
  await hostPage.getByTestId('setting-side-host-red').click({ force: true });
  await guestPage.getByTestId('lobby-ready-toggle').click();
  await expect(guestPage.getByTestId('lobby-ready-toggle')).toHaveText('取消准备', { timeout: 10_000 });
  await hostPage.getByTestId('lobby-ready-toggle').click();
  await expect(hostPage.getByTestId('lobby-start-hint')).toContainText('双方已就绪', { timeout: 10_000 });
  await hostPage.getByTestId('lobby-start').click();
  await expect(hostPage.getByTestId('online-game')).toBeVisible({ timeout: 10_000 });
  await expect(guestPage.getByTestId('online-game')).toBeVisible({ timeout: 10_000 });
  await expect(hostPage.getByTestId('shuffling-banner')).toHaveCount(0, { timeout: 2_000 });
}

/** 等待本页翻牌动画结束：动画期间棋盘点击会被交互层忽略。 */
async function waitForFlipIdle(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll('[data-testid^="cell-"]')).every(
            (el) => el.getAttribute('data-flip-phase') === 'none',
          ),
        ),
      { timeout: 5_000 },
    )
    .toBe(true);
}

/** 逻辑坐标下的 90 格快照：文字（明暗/棋子）+ 明暗状态 + 最近一步轨迹标记。 */
async function getBoardState(page: Page): Promise<Array<{ key: string; text: string; state: string; recent: string }>> {
  return page.evaluate(() => {
    const result: Array<{ key: string; text: string; state: string; recent: string }> = [];
    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 9; x += 1) {
        const el = document.querySelector(`[data-testid="cell-${x}-${y}"]`);
        result.push({
          key: `${x}-${y}`,
          text: (el?.querySelector('.piece-text')?.textContent ?? '').trim(),
          state: el?.getAttribute('data-cell-state') ?? '',
          recent: el?.getAttribute('data-recent-action') ?? '',
        });
      }
    }
    return result;
  });
}

async function getLatestGameStatePayload(page: Page): Promise<any> {
  return page.evaluate(() => {
    const broadcast = (window as any).__lastGameState?.payload ?? null;
    if (broadcast) {
      return broadcast;
    }
    // 中途加入且尚无增量广播时，权威状态来自 welcome 内嵌的对局快照。
    const welcome = (window as any).__lastWelcome?.payload ?? null;
    if (welcome?.game) {
      return {
        matchId: welcome.game.matchId,
        seed: welcome.game.seed,
        stepNumber: welcome.game.stepNumber,
        state: welcome.game.gameState,
      };
    }
    return null;
  });
}

/** 三端局面一致性：90 格明暗/棋子/最近一步轨迹 + 步数 + 回合 + 32 枚棋子属性。 */
async function expectThreeWaySync(hostPage: Page, guestPage: Page, spectatorPage: Page, stepNumber: number): Promise<void> {
  await expect(hostPage.getByTestId('step-number')).toHaveText(`第 ${stepNumber} 步`, { timeout: 10_000 });
  await expect(guestPage.getByTestId('step-number')).toHaveText(`第 ${stepNumber} 步`, { timeout: 10_000 });
  await expect(spectatorPage.getByTestId('step-number')).toHaveText(`第 ${stepNumber} 步`, { timeout: 10_000 });

  const hostCells = await getBoardState(hostPage);
  const guestCells = await getBoardState(guestPage);
  const spectatorCells = await getBoardState(spectatorPage);
  expect(spectatorCells).toEqual(hostCells);
  expect(guestCells).toEqual(hostCells);

  const hostPayload = await getLatestGameStatePayload(hostPage);
  const guestPayload = await getLatestGameStatePayload(guestPage);
  const spectatorPayload = await getLatestGameStatePayload(spectatorPage);
  expect(hostPayload.stepNumber).toBe(stepNumber);
  expect(guestPayload.stepNumber).toBe(stepNumber);
  expect(spectatorPayload.stepNumber).toBe(stepNumber);
  expect(hostPayload.state.currentTurn).toBe(guestPayload.state.currentTurn);
  expect(hostPayload.state.currentTurn).toBe(spectatorPayload.state.currentTurn);
  expect(hostPayload.state.pieces).toEqual(guestPayload.state.pieces);
  expect(hostPayload.state.pieces).toEqual(spectatorPayload.state.pieces);
  expect(hostPayload.state.recentAction).toEqual(spectatorPayload.state.recentAction);
}

/** 相同样本序号下的权威时钟逐字段一致（浏览器插值不要求逐毫秒相等）。 */
async function expectClockConsistent(pages: Page[]): Promise<void> {
  const clocks = await Promise.all(
    pages.map((page) =>
      page.evaluate(() => {
        return (window as any).__clockBySeq as Record<string, any>;
      }),
    ),
  );
  const maxSeqs = clocks.map((bySeq) => Math.max(-1, ...Object.keys(bySeq).map(Number)));
  const commonSeq = Math.min(...maxSeqs);
  expect(commonSeq).toBeGreaterThanOrEqual(0);
  const reference = clocks[0][String(commonSeq)].payload.clock;
  for (const bySeq of clocks) {
    expect(bySeq[String(commonSeq)].payload.clock).toEqual(reference);
  }
}

test.describe('lan spectator mode: live watching, read-only enforcement and resume', () => {
  test('a spectator joins mid-game, follows every action in sync and cannot operate anything', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const hostErrors = watchConsole(hostPage);
    const room = await createRoom(hostPage);

    const guestContext = await browser.newContext();
    const guestPage = await openGuest(guestContext, room.port);
    const guestErrors = watchConsole(guestPage);
    await joinRoom(guestPage, `127.0.0.1:${room.port}`);
    await readyAndStart(hostPage, guestPage);

    // 前两步：红方翻 (0,6) 炮，黑方翻 (0,0) 砲。
    await waitForFlipIdle(hostPage);
    await hostPage.getByTestId('cell-0-6').click();
    await expect(hostPage.getByTestId('step-number')).toHaveText('第 1 步', { timeout: 5_000 });
    await waitForFlipIdle(guestPage);
    await guestPage.getByTestId('cell-0-0').click();
    await expect(hostPage.getByTestId('step-number')).toHaveText('第 2 步', { timeout: 5_000 });

    // ====== 第三人以显式旁观身份中途加入：快照立即对齐当前局面 ======
    const spectatorContext = await browser.newContext();
    const spectatorPage = await openGuest(spectatorContext, room.port);
    const spectatorErrors = watchConsole(spectatorPage);
    await spectatorPage.getByTestId('join-spectate').click();
    await expect(spectatorPage.getByTestId('online-game')).toBeVisible({ timeout: 10_000 });
    await expect(spectatorPage.getByTestId('lobby-started')).toContainText('旁观视角（红方在下）');
    await expect(spectatorPage.getByTestId('turn-indicator')).toContainText('轮到红方行动');

    await expectThreeWaySync(hostPage, guestPage, spectatorPage, 2);

    // 中途加入即为当前快照，不从头回放：welcome 直接携带完整对局。
    const joinWelcome = await spectatorPage.evaluate(() => (window as any).__lastWelcome?.payload ?? null);
    expect(joinWelcome.role).toBe('spectator');
    expect(joinWelcome.game.stepNumber).toBe(2);
    expect(joinWelcome.game.seed).toBe(42);
    expect(joinWelcome.resumeToken).toBeTruthy();

    await screenshot(spectatorPage, '01-mid-join-snapshot');
    await screenshot(hostPage, '02-host-with-spectator');

    // ====== 只读校验（UI 层）：无任何操作入口，棋盘按钮禁用 ======
    await expect(spectatorPage.getByTestId('spectator-readonly-note')).toBeVisible();
    await expect(spectatorPage.getByTestId('btn-undo')).toHaveCount(0);
    await expect(spectatorPage.getByTestId('btn-draw')).toHaveCount(0);
    await expect(spectatorPage.getByTestId('btn-resign')).toHaveCount(0);
    await expect(spectatorPage.getByTestId('btn-quick-phrase')).toHaveCount(0);
    await expect(spectatorPage.getByTestId('spectate-exit')).toContainText('离开观看');
    await expect(spectatorPage.getByTestId('cell-4-3')).toBeDisabled();

    // 点击棋盘不产生任何动作发送。
    await spectatorPage.getByTestId('cell-4-3').click({ force: true });
    const sentAfterClicks = await spectatorPage.evaluate(() =>
      (window as any).__wsSent.filter((m: any) => m.type !== 'ping' && m.type !== 'pong' && m.type !== 'hello').length,
    );
    expect(sentAfterClicks).toBe(0);

    // ====== 只读校验（协议层）：真实 socket 伪造动作/大厅/短语消息全部被拒且零副作用 ======
    await spectatorPage.evaluate(() => {
      const ws = (window as any).__roomWs;
      const welcome = (window as any).__lastWelcome.payload;
      const game = (window as any).__lastGameState?.payload ?? welcome.game;
      const base = { version: 6, roomId: welcome.roomId };
      ws.send(
        JSON.stringify({
          ...base,
          type: 'game.action',
          requestId: 'forged-action',
          payload: {
            matchId: game.matchId,
            stepNumber: game.stepNumber,
            revision: game.revision,
            action: { type: 'flip', position: { x: 4, y: 3 } },
          },
        }),
      );
      ws.send(
        JSON.stringify({
          ...base,
          type: 'lobby.ready',
          payload: { ready: true, settingsVersion: 1 },
        }),
      );
      ws.send(
        JSON.stringify({
          ...base,
          type: 'chat.phrase',
          requestId: 'forged-phrase',
          payload: { matchId: game.matchId, phraseId: 'phrase-greeting-1' },
        }),
      );
      ws.send(
        JSON.stringify({
          ...base,
          type: 'game.resign',
          requestId: 'forged-resign',
          payload: { matchId: game.matchId, revision: game.revision },
        }),
      );
    });

    await expect
      .poll(async () => spectatorPage.evaluate(() => (window as any).__lastGameRejected?.requestId ?? null), { timeout: 10_000 })
      .toBe('forged-resign');
    const gameRejection = await spectatorPage.evaluate(() => (window as any).__lastGameRejected.payload);
    expect(gameRejection.reason).toContain('旁观者');
    await expect
      .poll(async () => spectatorPage.evaluate(() => (window as any).__lastLobbyRejected?.payload?.code ?? null), { timeout: 10_000 })
      .toBe('SPECTATOR_READONLY');
    await expect
      .poll(async () => spectatorPage.evaluate(() => (window as any).__lastPhraseRejected?.payload?.code ?? null), { timeout: 10_000 })
      .toBe('NOT_A_PLAYER');

    // 伪造请求零副作用：三端仍是第 2 步同一局面。
    await expect(hostPage.getByTestId('step-number')).toHaveText('第 2 步');
    await expect(guestPage.getByTestId('step-number')).toHaveText('第 2 步');
    await expectThreeWaySync(hostPage, guestPage, spectatorPage, 2);

    // ====== 后续动作逐动作三端一致：吃子 / 翻牌 / 走子 ======
    // 第 3 步：红方 (0,6) 炮翻山吃 (0,0) 黑砲。
    await waitForFlipIdle(hostPage);
    await hostPage.getByTestId('cell-0-6').click();
    await expect(hostPage.getByTestId('cell-0-6')).toHaveClass(/selected/);
    await hostPage.getByTestId('cell-0-0').click();
    await expectThreeWaySync(hostPage, guestPage, spectatorPage, 3);
    // 最近一步轨迹标记三端一致（起点 move-from）。
    const hostAfter3 = await getBoardState(hostPage);
    const spectatorAfter3 = await getBoardState(spectatorPage);
    expect(spectatorAfter3.find((c) => c.key === '0-6')?.recent).toBe(hostAfter3.find((c) => c.key === '0-6')?.recent);
    expect(hostAfter3.find((c) => c.key === '0-6')?.recent).toBe('move-from');
    expect(hostAfter3.find((c) => c.key === '0-0')?.recent).toBe('capture');

    // 第 4 步：黑方翻 (0,3) 卒。
    await waitForFlipIdle(guestPage);
    await guestPage.getByTestId('cell-0-3').click();
    await expectThreeWaySync(hostPage, guestPage, spectatorPage, 4);

    // ====== 协商中立只读展示：黑方发起求和，旁观端无回应入口 ======
    await guestPage.getByTestId('btn-draw').click();
    await expect(spectatorPage.getByTestId('negotiation-dialog')).toContainText('求和协商进行中', { timeout: 10_000 });
    await expect(spectatorPage.getByTestId('negotiation-agree-btn')).toHaveCount(0);
    await expect(spectatorPage.getByTestId('negotiation-reject-btn')).toHaveCount(0);
    await expect(hostPage.getByTestId('negotiation-agree-btn')).toBeVisible({ timeout: 10_000 });
    await hostPage.getByTestId('negotiation-reject-btn').click();
    await expect(spectatorPage.getByTestId('negotiation-toast')).toBeVisible({ timeout: 10_000 });
    await screenshot(spectatorPage, '03-negotiation-readonly');

    // 第 5 步：红方翻 (4,3) 卒。
    await waitForFlipIdle(hostPage);
    await hostPage.getByTestId('cell-4-3').click();
    await expectThreeWaySync(hostPage, guestPage, spectatorPage, 5);

    // 第 6 步：黑方 (0,3) 卒走到 (0,4)。
    await waitForFlipIdle(guestPage);
    await guestPage.getByTestId('cell-0-3').click();
    await expect(guestPage.getByTestId('cell-0-3')).toHaveClass(/selected/);
    await guestPage.getByTestId('cell-0-4').click();
    await expectThreeWaySync(hostPage, guestPage, spectatorPage, 6);
    await screenshot(spectatorPage, '04-after-move-trace');

    // 相同样本序号下的权威时钟逐字段一致。
    await expectClockConsistent([hostPage, guestPage, spectatorPage]);

    // 名单与在线人数：大厅/对局内均可查看，三端互见。
    await expect(spectatorPage.getByTestId('spectator-count')).toHaveText('旁观 1 人在线');
    await expect(hostPage.getByTestId('spectator-count')).toHaveText('旁观 1 人在线');
    await expect(hostPage.getByTestId('spectator-item')).toContainText('旁观');

    // 新人数/名单在 1366×768 与 683×768 下不产生横向溢出。
    for (const viewport of [
      { width: 1366, height: 768 },
      { width: 683, height: 768 },
    ]) {
      await spectatorPage.setViewportSize(viewport);
      const overflow = await spectatorPage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    }

    // ====== 真实终局广播：黑方认输，旁观端中立结算且无对局发送入口 ======
    await guestPage.getByTestId('btn-resign').click();
    await guestPage.getByTestId('confirm-resign-btn').click();
    await expect(spectatorPage.getByTestId('game-result-modal')).toBeVisible({ timeout: 10_000 });
    await expect(spectatorPage.getByTestId('result-outcome-title')).toHaveText('红方获胜！');
    await expect(spectatorPage.getByTestId('result-reason')).toHaveText('一方认输');
    await expect(spectatorPage.getByTestId('btn-rematch')).toHaveCount(0);
    await expect(spectatorPage.getByTestId('btn-return-lobby')).toHaveCount(0);
    await expect(hostPage.getByTestId('game-result-modal')).toBeVisible({ timeout: 10_000 });
    await expect(hostPage.getByTestId('result-outcome-title')).toHaveText('胜利！');
    await screenshot(spectatorPage, '05-settlement-readonly');

    // Escape 只本地收起结果层，不触发任何发送（旁观端），并继续观看。
    await spectatorPage.keyboard.press('Escape');
    await expect(spectatorPage.getByTestId('game-result-modal')).toHaveCount(0);
    await expect(spectatorPage.getByTestId('online-game')).toBeVisible();
    const sentAfterEscape = await spectatorPage.evaluate(() =>
      (window as any).__wsSent.filter((m: any) => m.type === 'lobby.return').length,
    );
    expect(sentAfterEscape).toBe(0);

    // 玩家侧结束：房主返回大厅后关闭房间，旁观端收到解散提示并回到加入页面。
    await hostPage.getByTestId('btn-return-lobby').click();
    await expect(hostPage.getByTestId('room-address-main')).toBeVisible({ timeout: 10_000 });
    await hostPage.getByTestId('close-room').click();
    await hostPage.getByTestId('confirm-yes').click();
    await expect(hostPage.getByTestId('menu-create')).toBeVisible({ timeout: 5_000 });
    await expect(spectatorPage.getByTestId('room-closed-notice')).toContainText('房主已关闭房间', { timeout: 10_000 });
    await expect(spectatorPage.getByTestId('join-submit')).toBeVisible();
    await screenshot(spectatorPage, '05-room-closed-notice');

    expect(hostErrors).toEqual([]);
    expect(guestErrors).toEqual([]);
    expect(spectatorErrors).toEqual([]);

    await hostContext.close();
    await guestContext.close();
    await spectatorContext.close();
  });

  test('a full-room joiner auto-spectates and resumes after a mid-game drop with a fresh snapshot', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const room = await createRoom(hostPage);

    const guestContext = await browser.newContext();
    const guestPage = await openGuest(guestContext, room.port);
    await joinRoom(guestPage, `127.0.0.1:${room.port}`);
    await readyAndStart(hostPage, guestPage);

    await waitForFlipIdle(hostPage);
    await hostPage.getByTestId('cell-0-6').click();
    await expect(hostPage.getByTestId('step-number')).toHaveText('第 1 步', { timeout: 5_000 });
    await waitForFlipIdle(guestPage);
    await guestPage.getByTestId('cell-0-0').click();
    await expect(hostPage.getByTestId('step-number')).toHaveText('第 2 步', { timeout: 5_000 });

    // ====== 满员后普通加入自动分流为旁观 ======
    const spectatorContext = await browser.newContext();
    const spectatorPage = await openGuest(spectatorContext, room.port);
    const spectatorErrors = watchConsole(spectatorPage);
    await spectatorPage.getByTestId('join-submit').click();
    await expect(spectatorPage.getByTestId('online-game')).toBeVisible({ timeout: 10_000 });
    await expect(spectatorPage.getByTestId('lobby-started')).toContainText('旁观视角（红方在下）');
    const autoWelcome = await spectatorPage.evaluate(() => (window as any).__lastWelcome?.payload ?? null);
    expect(autoWelcome.role).toBe('spectator');
    await expectThreeWaySync(hostPage, guestPage, spectatorPage, 2);

    // ====== 旁观者断线期间棋手继续走棋 ======
    await spectatorPage.evaluate(() => {
      (window as any).__lastWelcome = null;
      // 暂时屏蔽重连：保证走子确实发生在断线窗口内。
      (window as any).__blockWs = true;
      (window as any).__roomWs?.close();
    });
    await expect(spectatorPage.getByTestId('connection-banner')).toBeVisible({ timeout: 5_000 });

    // 断线后推进两步（第 3 步吃子、第 4 步翻牌）。
    await waitForFlipIdle(hostPage);
    await hostPage.getByTestId('cell-0-6').click();
    await expect(hostPage.getByTestId('cell-0-6')).toHaveClass(/selected/);
    await hostPage.getByTestId('cell-0-0').click();
    await waitForFlipIdle(guestPage);
    await guestPage.getByTestId('cell-0-3').click();
    await expect(hostPage.getByTestId('step-number')).toHaveText('第 4 步', { timeout: 5_000 });

    // ====== 断线重连：恢复旁观身份并快照追上当前局面，无从头回放 ======
    await spectatorPage.evaluate(() => {
      (window as any).__blockWs = false;
    });
    await spectatorPage.getByTestId('reconnect-button').click();
    await expect
      .poll(async () => spectatorPage.evaluate(() => (window as any).__lastWelcome?.payload?.role ?? null), { timeout: 15_000 })
      .toBe('spectator');
    const resumeWelcome = await spectatorPage.evaluate(() => (window as any).__lastWelcome?.payload ?? null);
    // 重连快照直接给出当前局面：第 4 步，而非第 0 步回放。
    expect(resumeWelcome.game.stepNumber).toBe(4);
    await expect(spectatorPage.getByTestId('step-number')).toHaveText('第 4 步', { timeout: 10_000 });
    await expect(spectatorPage.getByTestId('online-game')).toBeVisible();

    const hostCells = await getBoardState(hostPage);
    const spectatorCells = await getBoardState(spectatorPage);
    expect(spectatorCells).toEqual(hostCells);

    // 恢复后继续增量跟进：第 5 步红方翻 (4,3)。
    await waitForFlipIdle(hostPage);
    await hostPage.getByTestId('cell-4-3').click();
    await expectThreeWaySync(hostPage, guestPage, spectatorPage, 5);
    await screenshot(spectatorPage, '06-resume-follow');

    // 旁观者主动离开观看，回到加入页面。
    await spectatorPage.getByTestId('spectate-exit').click();
    await spectatorPage.getByTestId('confirm-yes').click();
    await expect(spectatorPage.getByTestId('join-submit')).toBeVisible({ timeout: 5_000 });

    // 清理：房主关闭房间。
    await hostPage.getByTestId('close-room').click();
    await hostPage.getByTestId('confirm-yes').click();
    await expect(hostPage.getByTestId('menu-create')).toBeVisible({ timeout: 5_000 });

    expect(spectatorErrors).toEqual([]);
    await hostContext.close();
    await guestContext.close();
    await spectatorContext.close();
  });
});
