import { expect, test, type Page } from '@playwright/test';
import { adoptedState, BrowserNetworkFaults } from './helpers/network-faults';

async function flipIdle(page: Page) {
  await expect.poll(() => page.locator('[data-flip-phase]:not([data-flip-phase="none"])').count()).toBe(0);
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 683, height: 768 }]) {
  test(`weak network converges with players and spectator at ${viewport.width}×${viewport.height}`, async ({ browser }, testInfo) => {
    const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({ viewport })));
    const pages = await Promise.all(contexts.map(c => c.newPage()));
    const [host, guest, spectator] = pages;
    const faults = [new BrowserNetworkFaults(), new BrowserNetworkFaults(), new BrowserNetworkFaults()];
    const errors: string[] = [];
    pages.forEach(p => p.on('pageerror', e => errors.push(e.message)));
    async function capture(page: Page, name: string) {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.evaluate(() => scrollTo(0, 0));
      for (const dialog of await page.getByRole('dialog').all()) {
        if (!await dialog.isVisible()) continue;
        const box = (await dialog.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      }
      // The in-game shell contains no connection address or recovery credential.
      await page.screenshot({ fullPage: false, path: testInfo.outputPath(`${name}.png`) });
    }
    async function consistent(step: number) {
      await expect.poll(async () => (await Promise.all(pages.map(p => adoptedState(p)))).every(s =>
        s.status === 'connected' && s.game!.stepNumber === step && !s.game!.pendingAction), { timeout: 8000 }).toBe(true);
      const authority = faults.map(f => f.authority).filter(Boolean).sort((a, b) => b.revision - a.revision)[0];
      await expect.poll(async () => (await Promise.all(pages.map(p => adoptedState(p)))).map(s =>
        ({ revision: s.game!.revision, state: s.game!.confirmedState })),
      { timeout: 8000 }).toEqual(pages.map(() => ({ revision: authority.revision, state: authority.state })));
      for (const page of pages) {
        const game = (await adoptedState(page)).game!;
        expect(game.displayState).toEqual(authority.state);
        expect(game.matchEvents).toEqual(authority.matchEvents);
        expect(game.pendingNegotiation).toEqual(authority.pendingNegotiation);
        expect(game.settlement).toEqual(authority.settlement ?? null);
        expect(game.clock!.paused).toBe(authority.clock.paused);
        expect(game.clock!.turn).toBe(authority.clock.turn);
      }
    }
    try {
      await Promise.all(pages.map((p, i) => faults[i].install(p)));
      await host.goto('/');
      await host.getByTestId('menu-create').click();
      await expect(host.getByTestId('room-address-main').or(host.getByTestId('online-game'))).toBeVisible({ timeout: 10000 });
      // A preceding failed test may leave a live room in the shared host runtime.
      if (await host.getByTestId('online-game').isVisible()) {
        const returnButton = host.getByTestId('btn-return-lobby');
        if (await returnButton.isVisible()) await returnButton.click();
        await host.getByTestId('close-room').click();
        await host.getByTestId('confirm-yes').click();
        await expect(host.getByTestId('menu-create')).toBeVisible();
        await host.getByTestId('menu-create').click();
      }
      await expect(host.getByTestId('room-address-main')).toBeVisible({ timeout: 10000 });
      const address = await host.getByTestId('room-address-main').textContent();
      const port = Number(address!.trim().split(':').at(-1));
      for (const page of [guest, spectator]) {
        await page.goto(`http://127.0.0.1:${port}/`);
        await page.getByTestId('menu-join').click();
        await page.getByTestId('join-address-input').fill(`127.0.0.1:${port}`);
        await page.getByTestId(page === spectator ? 'join-spectate' : 'join-submit').click();
      }
      await host.getByTestId('setting-side-host-red').click();
      await expect(host.getByTestId('setting-side-host-red')).toBeChecked();
      await host.getByTestId('setting-time-standard').click();
      await expect(host.getByTestId('setting-time-standard')).toBeChecked();
      await guest.getByTestId('lobby-ready-toggle').click();
      await expect(guest.getByTestId('lobby-ready-toggle')).toHaveText('取消准备');
      await host.getByTestId('lobby-ready-toggle').click();
      await expect(host.getByTestId('lobby-start-hint')).toContainText('双方已就绪');
      await host.getByTestId('lobby-start').click();
      for (const page of pages) {
        await expect(page.getByTestId('online-game')).toBeVisible();
        await expect(page.getByTestId('shuffling-banner')).toHaveCount(0);
      }
      // Drop only the action: heartbeats continue, and explicit sync must undo optimism.
      faults[0].rules.push({ direction: 'send', type: 'game.action', effect: 'drop' });
      await host.getByTestId('cell-0-6').click();
      await expect.poll(async () => Boolean((await adoptedState(host)).game!.pendingAction)).toBe(true);
      await consistent(0);
      await host.getByTestId('cell-0-6').click();
      await consistent(1);
      await Promise.all(pages.map(flipIdle));
      await capture(host, 'game');

      // Commit with delayed acknowledgement; disconnect before it is delivered.
      faults[1].rules.push({ direction: 'receive', type: 'game.patch', effect: 'hold' });
      await guest.getByTestId('cell-0-3').click();
      await expect.poll(() => faults[1].held.length).toBe(1);
      faults[1].rules.push({ direction: 'send', type: 'hello', effect: 'hold' });
      await faults[1].disconnect();
      await expect(guest.getByTestId('reconnect-button')).toBeVisible();
      const button = await guest.getByTestId('reconnect-button').boundingBox();
      expect(button!.width).toBeGreaterThanOrEqual(44);
      expect(button!.height).toBeGreaterThanOrEqual(44);
      expect(button!.x).toBeGreaterThanOrEqual(0);
      expect(button!.x + button!.width).toBeLessThanOrEqual(viewport.width);
      await capture(guest, 'disconnected');
      await guest.getByTestId('reconnect-button').click();
      await expect.poll(() => faults[1].held.length).toBe(2);
      faults[1].release();
      await consistent(2);
      await Promise.all(pages.map(flipIdle));

      await host.getByTestId('btn-undo').click();
      await expect(guest.getByTestId('negotiation-dialog')).toBeVisible();
      await capture(guest, 'negotiation');
      await capture(spectator, 'spectator');
      await faults[1].disconnect();
      await consistent(2);
      for (const page of pages) await expect(page.getByTestId('negotiation-dialog')).toHaveCount(0);
      await expect.poll(async () => (await adoptedState(guest)).game!.clock!.paused).toBe(false);
      const before = (await adoptedState(host)).game!.clock!.red.baseTimeRemainingMs!;
      await expect.poll(async () => (await adoptedState(host)).game!.clock!.red.baseTimeRemainingMs!).toBeLessThan(before);
      // Both directions jitter, with an application duplicate. The next move still commits once.
      faults[0].rules.push({ direction: 'send', type: 'game.action', effect: 'duplicate', delayMs: 100 });
      faults[2].rules.push({ direction: 'receive', type: 'game.patch', effect: 'delay', delayMs: 500 });
      await host.getByTestId('cell-2-6').click();
      await consistent(3);
      await Promise.all(pages.map(flipIdle));

      // No more clocks are broadcast after settlement. Periodic sync must still converge.
      faults[1].rules.push({ direction: 'receive', type: 'game.patch', effect: 'drop' });
      faults[2].rules.push({ direction: 'receive', type: 'game.patch', effect: 'drop' });
      await host.getByTestId('btn-resign').click();
      await host.getByTestId('confirm-resign-btn').click();
      await expect.poll(async () => (await Promise.all(pages.map(p => adoptedState(p)))).every(s => s.game!.settlement !== null),
        { timeout: 8000 }).toBe(true);
      await consistent(3);
      await capture(guest, 'settlement');
      expect((await adoptedState(host)).game!.confirmedState.actionHistory).toHaveLength(3);
      expect(errors).toEqual([]);
      await testInfo.attach('fault-log', { body: JSON.stringify(faults.map(f => f.log), null, 2), contentType: 'application/json' });
    } finally {
      faults.forEach(f => f.dispose());
      // Closing through the UI releases the single room before the next test.
      const returnButton = host.getByTestId('btn-return-lobby');
      if (await returnButton.isVisible().catch(() => false)) await returnButton.click();
      const close = host.getByTestId('close-room');
      if (await close.isVisible().catch(() => false)) {
        await close.click();
        await host.getByTestId('confirm-yes').click();
        await expect(host.getByTestId('menu-create')).toBeVisible();
      }
      await Promise.all(contexts.map(c => c.close()));
    }
  });
}
