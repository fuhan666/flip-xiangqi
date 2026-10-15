import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
import path from 'node:path';

const EVIDENCE_DIR = path.resolve(process.cwd(), '../evidence');

const VIEWPORTS = [
  { name: 'desktop-1920x1080', width: 1920, height: 1080, desktop: true },
  { name: 'desktop-1366x768', width: 1366, height: 768, desktop: true },
  { name: 'desktop-1024x768', width: 1024, height: 768, desktop: true },
  { name: 'mobile-390x844', width: 390, height: 844, desktop: false },
  { name: 'mobile-320x568', width: 320, height: 568, desktop: false },
];

const ALL_FACE_GLYPHS = ['帅', '仕', '相', '俥', '傌', '炮', '兵', '将', '士', '象', '車', '馬', '砲', '卒'];
const CALIGRAPHY_STACK =
  "'STKaiti', 'KaiTi', 'Kaiti SC', 'TW-Kai', 'BiauKai', 'Noto Serif SC', 'Songti SC', 'SimSun', serif";

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}

test.describe('board visual smoke', () => {
  for (const viewport of VIEWPORTS) {
    test(`geometry and screenshot at ${viewport.name}`, async ({ page }) => {
      const consoleErrors = watchConsole(page);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await expect(page.getByRole('grid', { name: '翻牌中国象棋棋盘' })).toBeVisible();

      const counts = await page.evaluate(() => ({
        hidden: document.querySelectorAll('.cell[data-cell-state="hidden"]').length,
        revealed: document.querySelectorAll('.cell[data-cell-state="revealed"]').length,
        empty: document.querySelectorAll('.cell[data-cell-state="empty"]').length,
      }));
      expect(counts).toEqual({ hidden: 30, revealed: 2, empty: 58 });

      const metrics = await page.evaluate(() => {
        const board = document.querySelector('.board') as HTMLElement;
        const frame = document.querySelector('.board-frame') as HTMLElement;
        const boardBox = board.getBoundingClientRect();
        const frameBox = frame.getBoundingClientRect();
        const cells = Array.from(document.querySelectorAll('.cell')) as HTMLElement[];
        const cellBoxes = cells.map((cell) => {
          const box = cell.getBoundingClientRect();
          return {
            testId: cell.getAttribute('data-testid'),
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            cx: box.x + box.width / 2,
            cy: box.y + box.height / 2,
          };
        });
        const discBoxes = cells
          .filter((cell) => cell.getAttribute('data-cell-state') !== 'empty')
          .map((cell) => {
            const disc = cell.querySelector('.piece-face') as HTMLElement;
            const box = disc.getBoundingClientRect();
            const cellBox = cell.getBoundingClientRect();
            return {
              width: box.width,
              height: box.height,
              cx: box.x + box.width / 2,
              cy: box.y + box.height / 2,
              cellCx: cellBox.x + cellBox.width / 2,
              cellCy: cellBox.y + cellBox.height / 2,
            };
          });
        return {
          board: { x: boardBox.x, y: boardBox.y, width: boardBox.width, height: boardBox.height },
          frame: { y: frameBox.y, height: frameBox.height, bottom: frameBox.bottom },
          cellBoxes,
          discBoxes,
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        };
      });

      expect(Math.abs(metrics.board.width / metrics.board.height - 0.9)).toBeLessThanOrEqual(0.01);
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);

      if (viewport.desktop) {
        expect(metrics.frame.y).toBeGreaterThanOrEqual(0);
        expect(metrics.frame.bottom).toBeLessThanOrEqual(viewport.height + 1);
      }

      for (const cell of metrics.cellBoxes) {
        expect(Math.abs(cell.width - cell.height), `${cell.testId} cell square`).toBeLessThanOrEqual(1.2);
        const [, xText, yText] = (cell.testId ?? '').split('-');
        const x = Number(xText);
        const y = Number(yText);
        const expectedCx = metrics.board.x + ((50 + 100 * x) / 900) * metrics.board.width;
        const expectedCy = metrics.board.y + ((50 + 100 * y) / 1000) * metrics.board.height;
        expect(Math.abs(cell.cx - expectedCx), `${cell.testId} x on intersection`).toBeLessThanOrEqual(1);
        expect(Math.abs(cell.cy - expectedCy), `${cell.testId} y on intersection`).toBeLessThanOrEqual(1);
      }

      const columnWidths = new Set(metrics.cellBoxes.map((cell) => Math.round(cell.width)));
      const rowHeights = new Set(metrics.cellBoxes.map((cell) => Math.round(cell.height)));
      expect(columnWidths.size).toBeLessThanOrEqual(2);
      expect(rowHeights.size).toBeLessThanOrEqual(2);

      for (const disc of metrics.discBoxes) {
        expect(Math.abs(disc.width - disc.height), 'disc round').toBeLessThanOrEqual(1);
        expect(Math.abs(disc.cx - disc.cellCx)).toBeLessThanOrEqual(1);
        expect(Math.abs(disc.cy - disc.cellCy)).toBeLessThanOrEqual(1);
      }

      await page.screenshot({
        fullPage: !viewport.desktop,
        path: path.join(EVIDENCE_DIR, `board-${viewport.name}.png`),
      });

      expect(consoleErrors).toEqual([]);
    });
  }

  test('board artwork contains river text, palaces and broken river lines', async ({ page }) => {
    await page.goto('/');
    const artwork = await page.evaluate(() => {
      const svg = document.querySelector('.board-artwork') as SVGSVGElement;
      const lines = Array.from(document.querySelectorAll('.board-artwork-lines line'));
      const palaces = Array.from(document.querySelectorAll('.board-artwork-palace line'));
      const riverTexts = Array.from(document.querySelectorAll('.board-artwork-river text')).map((node) => node.textContent);
      return {
        ariaHidden: svg.getAttribute('aria-hidden'),
        focusable: svg.getAttribute('focusable'),
        tabIndex: svg.getAttribute('tabindex'),
        lineCount: lines.length,
        palaceCount: palaces.length,
        riverTexts,
        innerSegments: lines
          .map((line) => ({
            x1: Number(line.getAttribute('x1')),
            y1: Number(line.getAttribute('y1')),
            y2: Number(line.getAttribute('y2')),
          }))
          .filter((line) => line.x1 !== 50 && line.x1 !== 850),
        marksPath: (document.querySelector('.board-artwork-marks') as SVGPathElement).getAttribute('d')?.length ?? 0,
      };
    });

    expect(artwork.ariaHidden).toBe('true');
    expect(artwork.focusable).toBe('false');
    expect(artwork.tabIndex).toBeNull();
    expect(artwork.lineCount).toBe(26);
    expect(artwork.palaceCount).toBe(4);
    expect(artwork.riverTexts).toEqual(['楚河', '汉界']);
    expect(artwork.innerSegments.every((line) => line.y2 === 450 || line.y1 === 550)).toBe(true);
    expect(artwork.marksPath).toBeGreaterThan(100);
  });

  test('hidden pieces expose identical DOM regardless of identity', async ({ page }) => {
    await page.goto('/');
    const hiddenHtml = await page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll('.cell[data-cell-state="hidden"]'));
      return cells.map((cell) => {
        const clone = cell.cloneNode(true) as HTMLElement;
        clone.removeAttribute('data-testid');
        clone.removeAttribute('aria-label');
        const coordinate = clone.querySelector('.coordinate');
        if (coordinate) {
          coordinate.textContent = '';
        }
        return clone.outerHTML;
      });
    });

    expect(hiddenHtml).toHaveLength(30);
    expect(new Set(hiddenHtml).size).toBe(1);
    expect(hiddenHtml[0]).toContain('暗');
    for (const glyph of ALL_FACE_GLYPHS) {
      expect(hiddenHtml[0]).not.toContain(glyph);
    }
    expect(hiddenHtml[0]).not.toMatch(/title=|data-piece|data-camp|data-type|piece-face-revealed/);

    const breathing = await page.evaluate(() => {
      const faces = Array.from(document.querySelectorAll('.piece-face-hidden'));
      return faces.map((face) => {
        const style = getComputedStyle(face);
        return `${style.animationName}|${style.animationDuration}|${style.animationIterationCount}`;
      });
    });
    expect(new Set(breathing).size).toBe(1);
    expect(breathing[0]).toContain('3.5s');
  });

  test('reduced motion stops the hidden-piece breathing', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto('/');
    const animationName = await page.evaluate(() => {
      const face = document.querySelector('.piece-face-hidden') as HTMLElement;
      return getComputedStyle(face).animationName;
    });
    expect(animationName).toBe('none');
    await context.close();
  });

  test('interaction flow: flip, select, move, undo, restart and keyboard', async ({ page }) => {
    const consoleErrors = watchConsole(page);
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/');

    const clickUntil = async (testId: string, attribute: string, value: string) => {
      await expect
        .poll(
          async () => {
            await page.getByTestId(testId).click();
            return page.getByTestId(testId).getAttribute(attribute);
          },
          { intervals: [250, 500, 1000], timeout: 15_000 },
        )
        .toBe(value);
    };

    const turn = page.locator('.board-turn-value');
    await expect(turn).toHaveText('红方回合');

    await clickUntil('cell-4-9', 'aria-pressed', 'true');
    await clickUntil('cell-4-8', 'data-recent-action', 'move-to');
    await expect(page.getByTestId('cell-4-9')).toHaveAttribute('data-recent-action', 'move-from');
    await expect(turn).toHaveText('黑方回合');

    await clickUntil('cell-4-3', 'data-cell-state', 'revealed');
    await expect(page.getByTestId('cell-4-3')).toHaveAttribute('data-recent-action', 'flip');

    await clickUntil('cell-4-8', 'aria-pressed', 'true');
    await clickUntil('cell-4-8', 'aria-pressed', 'false');

    await page.screenshot({
      fullPage: true,
      path: path.join(EVIDENCE_DIR, 'board-desktop-1366x768-midgame.png'),
    });

    await expect
      .poll(
        async () => {
          await page.getByRole('button', { name: '悔棋' }).click();
          return page.getByTestId('cell-4-3').getAttribute('data-cell-state');
        },
        { intervals: [250, 500, 1000], timeout: 15_000 },
      )
      .toBe('hidden');
    await expect(turn).toHaveText('黑方回合');

    await expect
      .poll(
        async () => {
          await page.getByRole('button', { name: '重新随机开局' }).click();
          return page.locator('.board-turn-value').textContent();
        },
        { intervals: [250, 500, 1000], timeout: 15_000 },
      )
      .toBe('红方回合');
    const counts = await page.evaluate(() => ({
      hidden: document.querySelectorAll('.cell[data-cell-state="hidden"]').length,
      revealed: document.querySelectorAll('.cell[data-cell-state="revealed"]').length,
    }));
    expect(counts).toEqual({ hidden: 30, revealed: 2 });

    await page.getByTestId('cell-0-0').focus();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('cell-1-0')).toBeFocused();
    await expect
      .poll(
        async () => {
          await page.keyboard.press('Enter');
          return page.getByTestId('cell-1-0').getAttribute('data-cell-state');
        },
        { intervals: [250, 500, 1000], timeout: 15_000 },
      )
      .toBe('revealed');
    await expect(page.getByTestId('cell-1-0')).toHaveAttribute('data-recent-action', 'flip');

    expect(consoleErrors).toEqual([]);
  });

  test('calligraphy font rendering evidence', async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/');
    await expect(page.getByRole('grid', { name: '翻牌中国象棋棋盘' })).toBeVisible();

    const client = await page.context().newCDPSession(page);
    await client.send('DOM.enable');
    await client.send('CSS.enable');
    const doc = await client.send('DOM.getDocument');
    const describeFonts = async (selector: string) => {
      const { nodeId } = await client.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
      if (!nodeId) {
        return { selector, entries: [] as string[], raw: null };
      }
      const result = (await client.send('CSS.getPlatformFontsForNode', { nodeId })) as unknown as {
        fonts?: Array<{ familyName: string; glyphCount?: number }>;
        glyphs?: Array<{ character?: string; familyName: string }>;
      };
      const entries =
        result.glyphs?.map((glyph) => `${glyph.character ?? '?'}:${glyph.familyName}`) ??
        result.fonts?.map((font) => `${font.familyName} x${font.glyphCount ?? '?'}`) ??
        [];
      return { selector, entries, raw: result };
    };

    const pieceFonts = await describeFonts('.cell.red .piece-text');
    const hiddenFonts = await describeFonts('.cell.hidden .piece-text');
    const riverFonts = await describeFonts('.board-artwork-river text');
    console.log('FONT_REPORT', JSON.stringify({ pieceFonts, hiddenFonts, riverFonts }));
    expect(pieceFonts.entries.length).toBeGreaterThan(0);
    expect(riverFonts.entries.length).toBeGreaterThan(0);

    await page.screenshot({
      fullPage: true,
      path: path.join(EVIDENCE_DIR, 'board-desktop-1366x768-fullpage.png'),
    });

    await page.setContent(`<!doctype html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <style>
      body {
        margin: 0;
        padding: 28px;
        background: #e8c692;
        color: #26201a;
        font-family: ${CALIGRAPHY_STACK};
      }
      .sheet {
        display: flex;
        flex-wrap: wrap;
        gap: 18px;
        align-items: center;
      }
      .disc {
        width: 96px;
        height: 96px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 58px;
        font-weight: 700;
        background: radial-gradient(circle at 34% 28%, rgba(255, 248, 222, 0.92), rgba(255, 248, 222, 0) 46%),
          radial-gradient(circle at 50% 56%, #f2d7a2 0%, #e7c284 52%, #cd9f5c 82%, #b1813f 100%);
        box-shadow: inset 0 -4px 8px rgba(122, 74, 32, 0.52), inset 0 0 0 3px rgba(96, 58, 22, 0.38);
      }
      .disc.red { color: #a2281c; }
      .disc.black { color: #26201a; }
      .river {
        font-size: 60px;
        letter-spacing: 24px;
        margin-top: 24px;
      }
    </style>
  </head>
  <body>
    <div class="sheet">
      ${ALL_FACE_GLYPHS.map((glyph, index) => `<div class="disc ${index < 7 ? 'red' : 'black'}">${glyph}</div>`).join('')}
    </div>
    <div class="river">楚河 汉界</div>
  </body>
</html>`);
    await page.screenshot({ fullPage: true, path: path.join(EVIDENCE_DIR, 'font-showcase.png') });
  });
});
