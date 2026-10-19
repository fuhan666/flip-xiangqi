import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import path from 'node:path';

const EVIDENCE_DIR = path.resolve(process.cwd(), '../evidence');

// 翻牌反馈动画（360ms）期间棋盘忽略操作；等待需覆盖该保护期，否则补点会被吞掉。
const FLIP_GUARD_MS = 480;

/**
 * 与引擎单测相同的 LCG：保证开局打乱完全确定，
 * 下面的坐标与棋子文字都是该开局下的固定常量。
 */
const SEED = 2;

const SEEDED_RNG = `(() => {
  let state = ${SEED} >>> 0;
  const lcg = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  let preambleCalls = 2;
  Math.random = () => {
    if (preambleCalls > 0) {
      preambleCalls -= 1;
      return 0.5;
    }
    return lcg();
  };
})();`;

/**
 * 在 Web Audio 边界观测真实调度：包装 AudioContext 构造与
 * OscillatorNode / AudioBufferSourceNode 的 start()，记录起点、波形与频率包络。
 * 不 mock 任何播放函数，页面代码走的是真实浏览器音频管线。
 */
const AUDIO_PROBE = `(() => {
  const probe = { contexts: 0, events: [] };
  window.__audioProbe = probe;

  const Original = window.AudioContext;
  if (!Original) {
    return;
  }

  const wrapParam = (param, name, bag) => {
    ['setValueAtTime', 'linearRampToValueAtTime', 'exponentialRampToValueAtTime'].forEach((method) => {
      const original = param[method];
      if (typeof original !== 'function') {
        return;
      }
      param[method] = function (value, ...rest) {
        bag.push({ name: name, method: method, value: value });
        return original.call(this, value, ...rest);
      };
    });
  };

  const origCreateOscillator = Original.prototype.createOscillator;
  Original.prototype.createOscillator = function () {
    const node = origCreateOscillator.call(this);
    const bag = [];
    wrapParam(node.frequency, 'frequency', bag);
    const origStart = node.start.bind(node);
    node.start = function (when, ...rest) {
      const freq = bag.filter((entry) => entry.name === 'frequency');
      const ramps = freq.filter((entry) => entry.method !== 'setValueAtTime');
      probe.events.push({
        kind: 'oscillator',
        waveform: node.type,
        startFrequency: freq.length > 0 ? freq[0].value : null,
        endFrequency: ramps.length > 0 ? ramps[ramps.length - 1].value : (freq.length > 0 ? freq[0].value : null),
      });
      return origStart(when, ...rest);
    };
    return node;
  };

  const origCreateBufferSource = Original.prototype.createBufferSource;
  Original.prototype.createBufferSource = function () {
    const node = origCreateBufferSource.call(this);
    const origStart = node.start.bind(node);
    node.start = function (when, ...rest) {
      probe.events.push({ kind: 'noise' });
      return origStart(when, ...rest);
    };
    return node;
  };

  const Patched = function (...args) {
    const ctx = new Original(...args);
    probe.contexts += 1;
    return ctx;
  };
  Patched.prototype = Original.prototype;
  window.AudioContext = Patched;
})();`;

/** 只记录最新 WebSocket 连接，便于在测试中模拟断线重连。 */
const WS_SPY = `(() => {
  const Original = window.WebSocket;
  window.__roomWs = null;
  window.WebSocket = class extends Original {
    constructor(...args) {
      super(...args);
      window.__roomWs = this;
    }
  };
})();`;

interface AudioEvent {
  kind: 'oscillator' | 'noise';
  waveform?: string;
  startFrequency?: number | null;
  endFrequency?: number | null;
}
interface PageHealth {
  errors: string[];
  audioWarnings: string[];
}

function watchPageHealth(page: Page): PageHealth {
  const errors: string[] = [];
  const audioWarnings: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    const type = message.type();
    const text = message.text();
    if (type === 'error') {
      errors.push(text);
    }
    if ((type === 'warning' || type === 'error') && /audio|autoplay/i.test(text)) {
      audioWarnings.push(`${type}: ${text}`);
    }
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  return { errors, audioWarnings };
}

async function audioEventCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __audioProbe: { events: unknown[] } }).__audioProbe.events.length);
}

async function audioContextCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __audioProbe: { contexts: number } }).__audioProbe.contexts);
}

async function audioEventsSince(page: Page, mark: number): Promise<AudioEvent[]> {
  return page.evaluate(
    (index) => (window as unknown as { __audioProbe: { events: AudioEvent[] } }).__audioProbe.events.slice(index),
    mark,
  );
}

async function waitForAudioEvents(page: Page, minimum: number): Promise<void> {
  await page.waitForFunction(
    (count) => (window as unknown as { __audioProbe: { events: unknown[] } }).__audioProbe.events.length >= count,
    minimum,
    { timeout: 8000 },
  );
}

async function flipHiddenCell(page: Page, x: number, y: number, glyph: string): Promise<void> {
  const cell = page.getByTestId(`cell-${x}-${y}`);
  await cell.click();
  await page.waitForTimeout(FLIP_GUARD_MS);
  if ((await cell.getAttribute('data-cell-state')) !== 'revealed') {
    await cell.click();
    await page.waitForTimeout(FLIP_GUARD_MS);
  }
  await expect(cell).toHaveAttribute('data-cell-state', 'revealed');
  await expect(cell.locator('.piece-text')).toHaveText(glyph);
}

async function selectAndMove(page: Page, from: [number, number], to: [number, number], glyph: string): Promise<void> {
  const fromCell = page.getByTestId(`cell-${from[0]}-${from[1]}`);
  const toCell = page.getByTestId(`cell-${to[0]}-${to[1]}`);
  await fromCell.click();
  await expect(fromCell).toHaveAttribute('aria-pressed', 'true');
  await toCell.click();
  await expect(toCell.locator('.piece-text')).toHaveText(glyph);
}

async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ fullPage: true, path: path.join(EVIDENCE_DIR, `audio-feedback-${name}.png`) });
}

/** 主动关闭房间并等待宿主释放，避免残留房间影响后续用例建房。 */
async function closeRoomAndWaitReleased(hostPage: Page): Promise<void> {
  const returnButton = hostPage.getByTestId('btn-return-lobby');
  if (await returnButton.isVisible().catch(() => false)) {
    await returnButton.click().catch(() => undefined);
  }

  const closeButton = hostPage.getByTestId('close-room').first();
  if (await closeButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await closeButton.click().catch(() => undefined);
    const confirmButton = hostPage.getByTestId('confirm-yes');
    if (await confirmButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await confirmButton.click().catch(() => undefined);
    }
  }

  await expect
    .poll(
      () =>
        hostPage
          .evaluate(async () => {
            try {
              const response = await fetch('/api/room/status');
              const payload = (await response.json()) as { active?: boolean };
              return payload.active === true;
            } catch {
              return true;
            }
          })
          .catch(() => true),
      { timeout: 20_000, message: '房间未在超时内释放，会影响后续用例建房' },
    )
    .toBe(false);
}

function oscillators(events: AudioEvent[]): AudioEvent[] {
  return events.filter((event) => event.kind === 'oscillator');
}

function noiseBursts(events: AudioEvent[]): AudioEvent[] {
  return events.filter((event) => event.kind === 'noise');
}

interface RoomHandle {
  address: string;
  port: number;
}

async function createRoom(page: Page): Promise<RoomHandle> {
  await page.goto('/');
  await page.getByTestId('menu-create').click();
  const addressElement = page.getByTestId('room-address-main');
  await expect(addressElement).toBeVisible();
  const address = ((await addressElement.textContent()) ?? '').trim();
  const port = Number(address.split(':').pop());
  await expect(page.getByTestId('lobby-ready-toggle')).toBeVisible({ timeout: 10_000 });
  return { address, port };
}

async function openGuest(page: Page, port: number): Promise<void> {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.getByTestId('menu-join').click();
}

async function joinRoom(page: Page, address: string): Promise<void> {
  await page.getByTestId('join-address-input').fill(address);
  await page.getByTestId('join-submit').click();
  await expect(page.getByTestId('lobby-ready-toggle')).toBeVisible({ timeout: 10_000 });
}

async function clickFirstHiddenCell(page: Page): Promise<void> {
  const cell = page.locator('[data-cell-state="hidden"]').first();
  await cell.click();
  await page.waitForTimeout(FLIP_GUARD_MS);
}

/** 本文件中正在使用房间的宿主页面，用例结束（含失败）后统一释放房间。 */
let activeHostPage: Page | null = null;

test.afterEach(async () => {
  if (!activeHostPage) {
    return;
  }
  const hostPage = activeHostPage;
  activeHostPage = null;
  await closeRoomAndWaitReleased(hostPage);
});

test.describe('audio feedback: synthesized cues, controls and two-client playback', () => {
  test('local game schedules a distinct synthesized cue per action and stays silent on illegal input', async ({
    page,
  }) => {
    const health = watchPageHealth(page);
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.addInitScript(SEEDED_RNG);
    await page.addInitScript(AUDIO_PROBE);
    await page.goto('/#/local');

    await expect(page.getByTestId('audio-controls')).toBeVisible();
    // 自动播放策略：首次用户手势前不创建 AudioContext，控制台无 autoplay 告警。
    expect(await audioContextCount(page)).toBe(0);

    // 翻牌：清脆上扬的短音（1 振荡器 + 1 噪声）。
    let mark = await audioEventCount(page);
    await flipHiddenCell(page, 7, 2, '俥');
    let events = await audioEventsSince(page, mark);
    expect(oscillators(events)).toHaveLength(1);
    expect(noiseBursts(events)).toHaveLength(1);
    expect(oscillators(events)[0].endFrequency!).toBeGreaterThan(oscillators(events)[0].startFrequency!);
    expect(await audioContextCount(page)).toBe(1);
    await screenshot(page, '01-flip');

    await flipHiddenCell(page, 2, 3, '士');

    // 落子：低频下坠的木敲声（2 振荡器 + 1 噪声）。
    mark = await audioEventCount(page);
    await selectAndMove(page, [7, 2], [5, 2], '俥');
    events = await audioEventsSince(page, mark);
    expect(oscillators(events)).toHaveLength(2);
    expect(noiseBursts(events)).toHaveLength(1);
    const body = oscillators(events).reduce((left, right) =>
      (left.startFrequency ?? 0) <= (right.startFrequency ?? 0) ? left : right,
    );
    expect(body.endFrequency!).toBeLessThan(body.startFrequency!);

    await flipHiddenCell(page, 1, 0, '傌');

    // 非法操作：状态不变、历史不追加，必须完全无声。
    mark = await audioEventCount(page);
    await page.getByTestId('cell-5-2').click();
    await page.getByTestId('cell-0-2').click();
    await expect(page.locator('.error')).toHaveText('非法操作：路径被阻挡');
    await page.waitForTimeout(200);
    expect(await audioEventsSince(page, mark)).toEqual([]);

    await flipHiddenCell(page, 7, 7, '俥');
    await flipHiddenCell(page, 7, 0, '相');
    await selectAndMove(page, [7, 7], [7, 4], '俥');
    await flipHiddenCell(page, 8, 0, '兵');
    await selectAndMove(page, [7, 4], [2, 4], '俥');
    await flipHiddenCell(page, 0, 0, '炮');

    // 吃子：破碎感（3 振荡器 + 2 噪声），完全替代落子声。
    mark = await audioEventCount(page);
    await selectAndMove(page, [2, 4], [2, 3], '俥');
    await expect(page.getByTestId('cell-2-3')).toHaveAttribute('data-recent-action', 'capture');
    events = await audioEventsSince(page, mark);
    expect(oscillators(events)).toHaveLength(3);
    expect(noiseBursts(events)).toHaveLength(2);
    await screenshot(page, '02-capture');

    expect(health.errors).toEqual([]);
    expect(health.audioWarnings).toEqual([]);
  });

  test('volume and mute take effect immediately and survive a reload', async ({ page }) => {
    const health = watchPageHealth(page);
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.addInitScript(SEEDED_RNG);
    await page.addInitScript(AUDIO_PROBE);
    await page.goto('/#/local');

    const muteToggle = page.getByTestId('audio-mute-toggle');
    const volumeSlider = page.getByTestId('audio-volume-slider');
    await expect(muteToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(volumeSlider).toHaveValue('60');

    // 静音后立即停止调度新声部。
    await muteToggle.click();
    await expect(muteToggle).toHaveAttribute('aria-pressed', 'true');
    let mark = await audioEventCount(page);
    await flipHiddenCell(page, 7, 2, '俥');
    await page.waitForTimeout(150);
    expect(await audioEventsSince(page, mark)).toEqual([]);

    // 解除静音后立即恢复。
    await muteToggle.click();
    await expect(muteToggle).toHaveAttribute('aria-pressed', 'false');
    mark = await audioEventCount(page);
    await flipHiddenCell(page, 2, 3, '士');
    await waitForAudioEvents(page, mark + 1);

    // 音量归零同样静音。
    await volumeSlider.fill('0');
    await expect(volumeSlider).toHaveValue('0');
    mark = await audioEventCount(page);
    await page.getByTestId('cell-7-2').click();
    await page.waitForTimeout(150);
    expect(await audioEventsSince(page, mark)).toEqual([]);

    await volumeSlider.fill('35');
    await expect(volumeSlider).toHaveValue('35');
    await screenshot(page, '03-controls');

    // 刷新后设置保持，且首个手势即可继续发声。
    await page.reload();
    await expect(page.getByTestId('audio-volume-slider')).toHaveValue('35');
    mark = await audioEventCount(page);
    expect(mark).toBe(0);
    await page.getByTestId('cell-7-2').click();
    await waitForAudioEvents(page, 1);
    await expect(page.getByTestId('audio-volume-slider')).toHaveValue('35');

    expect(health.errors).toEqual([]);
    expect(health.audioWarnings).toEqual([]);
  });

  test('online match: each client plays locally, settings stay independent, recovery stays silent', async ({
    browser,
  }) => {
    const hostContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    const hostHealth = watchPageHealth(hostPage);
    await hostPage.addInitScript(AUDIO_PROBE);
    await hostPage.addInitScript(WS_SPY);
    const room = await createRoom(hostPage);
    activeHostPage = hostPage;

    const guestContext = await browser.newContext();
    const guestPage = await guestContext.newPage();
    const guestHealth = watchPageHealth(guestPage);
    await guestPage.addInitScript(AUDIO_PROBE);
    await guestPage.addInitScript(WS_SPY);
    await openGuest(guestPage, room.port);
    await joinRoom(guestPage, `127.0.0.1:${room.port}`);

    await hostPage.getByTestId('setting-side-host-red').click({ force: true });
    await guestPage.getByTestId('lobby-ready-toggle').click();
    await expect(guestPage.getByTestId('lobby-ready-toggle')).toHaveText('取消准备', { timeout: 10_000 });
    await hostPage.getByTestId('lobby-ready-toggle').click();
    await expect(hostPage.getByTestId('lobby-start-hint')).toContainText('双方已就绪', { timeout: 10_000 });
    await hostPage.getByTestId('lobby-start').click();
    await expect(hostPage.getByTestId('cell-4-9')).toBeVisible({ timeout: 15_000 });
    await expect(guestPage.getByTestId('cell-4-9')).toBeVisible({ timeout: 15_000 });

    const hostStart = await audioEventCount(hostPage);
    const guestStart = await audioEventCount(guestPage);

    // 房主翻牌：双端各自本地播放一次（乐观推测不发声，确认/广播只发声一次）。
    await clickFirstHiddenCell(hostPage);
    await waitForAudioEvents(hostPage, hostStart + 1);
    await waitForAudioEvents(guestPage, guestStart + 1);
    const hostAfterHostFlip = await audioEventCount(hostPage);
    const guestAfterHostFlip = await audioEventCount(guestPage);
    await hostPage.waitForTimeout(600);
    expect(await audioEventCount(hostPage)).toBe(hostAfterHostFlip);
    expect(await audioEventCount(guestPage)).toBe(guestAfterHostFlip);

    // 客人静音只影响本端：客人行动本端无声，房主照常发声。
    await guestPage.getByTestId('audio-mute-toggle').click();
    await expect(guestPage.getByTestId('audio-mute-toggle')).toHaveAttribute('aria-pressed', 'true');
    await clickFirstHiddenCell(guestPage);
    await waitForAudioEvents(hostPage, hostAfterHostFlip + 1);
    await guestPage.waitForTimeout(600);
    expect(await audioEventCount(guestPage)).toBe(guestAfterHostFlip);

    // 客人解除静音后恢复本端播放；房主设置不受影响。
    await guestPage.getByTestId('audio-mute-toggle').click();
    await expect(guestPage.getByTestId('audio-mute-toggle')).toHaveAttribute('aria-pressed', 'false');
    const hostBeforeHostFlip = await audioEventCount(hostPage);
    await clickFirstHiddenCell(hostPage);
    await waitForAudioEvents(hostPage, hostBeforeHostFlip + 1);
    await waitForAudioEvents(guestPage, guestAfterHostFlip + 1);
    await screenshot(guestPage, '04-online-guest');

    // 断线恢复：重新同步权威状态，绝不补播历史音效。
    const guestBeforeRecovery = await audioEventCount(guestPage);
    await guestPage.evaluate(() => (window as unknown as { __roomWs?: { close(): void } }).__roomWs?.close());
    const reconnectButton = guestPage.getByTestId('reconnect-button');
    if (await reconnectButton.isVisible().catch(() => false)) {
      await reconnectButton.click().catch(() => undefined);
    }
    await expect(guestPage.getByTestId('cell-4-9')).toBeVisible({ timeout: 15_000 });
    await guestPage.waitForTimeout(2000);
    expect(await audioEventCount(guestPage)).toBe(guestBeforeRecovery);

    // 认输终局：有胜方，双端各播一次胜利乐句。
    const hostBeforeEnd = await audioEventCount(hostPage);
    await hostPage.getByTestId('btn-resign').click();
    await hostPage.getByTestId('confirm-resign-btn').click();
    await waitForAudioEvents(hostPage, hostBeforeEnd + 1);
    await waitForAudioEvents(guestPage, guestBeforeRecovery + 1);
    await screenshot(hostPage, '05-online-victory');

    expect(hostHealth.errors).toEqual([]);
    expect(guestHealth.errors).toEqual([]);
    expect(hostHealth.audioWarnings).toEqual([]);
    expect(guestHealth.audioWarnings).toEqual([]);
  });
});
