import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const flip = (x: number, y: number) => [x,y];
const move = (x: number, y: number, tx: number, ty: number) => [x,y,tx,ty];
const actions = [flip(7,2), flip(2,3), move(7,2,5,2), flip(1,0), flip(7,7), flip(7,0), move(7,7,7,4), flip(8,0), move(7,4,2,4), flip(0,0), move(2,4,2,3), flip(8,6), move(2,3,2,4), flip(0,3), move(2,4,6,4), flip(2,9), flip(3,9), flip(4,6), move(3,9,3,5), flip(6,3), move(3,5,6,5), flip(2,6), move(6,5,6,3), flip(8,9), move(5,2,4,2)];
test('full game with undo -> TXT/JSON download -> read-only replay and local import at three viewport sizes', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.addInitScript(() => {
    let seed = 2; let preamble = 2;
    Math.random = () => { if (preamble-- > 0) return .5; seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };
  });
  await page.goto('/#/local');
  for (const [index, action] of actions.entries()) {
    await page.getByTestId(`cell-${action[0]}-${action[1]}`).click();
    if (action.length === 4) await page.getByTestId(`cell-${action[2]}-${action[3]}`).click();
    else await page.waitForTimeout(480);
    if (index === 2) {
      await page.getByRole('button', { name:'悔棋', exact:true }).click();
      await page.getByTestId('cell-7-2').click();
      await page.getByTestId('cell-5-2').click();
    }
  }
  await expect(page.getByRole('button', { name:'导出棋谱' })).toBeVisible();
  const board = page.locator('.board');
  const finalCells = await board.locator('.cell').evaluateAll((cells) => cells.map((c) => [c.getAttribute('data-testid'), c.getAttribute('data-cell-state'), c.textContent]));
  await page.getByRole('button', { name:'导出棋谱' }).click();
  const jsonDownload = page.waitForEvent('download');
  await page.getByRole('button', { name:'下载 JSON' }).click();
  const json = await jsonDownload;
  const jsonPath = await json.path();
  const data = JSON.parse(await readFile(jsonPath!, 'utf8'));
  expect(data.moves).toHaveLength(25);
  expect(data.moves.map((m: {stepNumber:number}) => m.stepNumber)).toEqual(Array.from({length:25},(_,i)=>i+1));
  expect(data.result).toMatchObject({ winner:'red', reason:'checkmate', totalSteps:25 });
  const textDownload = page.waitForEvent('download');
  await page.getByRole('button', { name:'下载 TXT' }).click();
  const txt = await textDownload;
  const text = await readFile((await txt.path())!, 'utf8');
  expect(text.split('\n').filter((l) => /^\d+\./.test(l))).toHaveLength(25);
  await page.getByRole('button', { name:'开始复盘' }).click();
  for (const [width, height] of [[1366, 768], [1920, 1080], [683, 768]]) {
    await page.setViewportSize({ width, height });
    const replay = page.getByRole('dialog', { name:'棋谱复盘' });
    await replay.getByRole('button', { name:'首步', exact:true }).click({ force:true });
    await expect(replay.locator('.cell[data-cell-state="hidden"]')).toHaveCount(30);
    await replay.getByRole('button', { name:'下一步', exact:true }).click();
    await expect(replay.getByTestId('cell-7-2')).toHaveAttribute('data-recent-action','flip');
    await replay.getByRole('button', { name:'末步', exact:true }).click();
    await expect(replay.locator('[aria-current="step"]')).toContainText('25.');
    await expect(replay.locator('.board-trace-line')).toHaveCount(1);
    expect(await replay.locator('.cell').evaluateAll((cells) => cells.map((c) => [c.getAttribute('data-testid'), c.getAttribute('data-cell-state'), c.textContent]))).toEqual(finalCells);
    await replay.getByRole('button', { name:'上一步', exact:true }).click();
    await expect(replay.getByTestId('cell-4-2')).toHaveAttribute('data-cell-state','empty');
    await replay.getByRole('button', { name:'末步', exact:true }).click();
    await page.waitForTimeout(1100);
    await expect(replay.locator('.board-trace-line')).toHaveCSS('opacity', '1');
    await expect(replay.getByTestId('cell-4-2')).toHaveCSS('opacity', '1');
    const toolbar = await replay.locator('.replay-toolbar').boundingBox();
    expect(toolbar!.x).toBeGreaterThanOrEqual(0);
    expect(toolbar!.x + toolbar!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path:testInfo.outputPath(`replay-${width}.png`) });
    await page.keyboard.press('Escape');
    if (width !== 683) {
      await page.getByLabel('选择 JSON 棋谱').setInputFiles(jsonPath!);
    }
  }
  await page.getByRole('button', { name:'重新随机开局' }).click();
  await expect(page.locator('.cell[data-cell-state="hidden"]')).toHaveCount(30);
  await page.getByLabel('选择 JSON 棋谱').setInputFiles(jsonPath!);
  await page.getByRole('dialog').getByRole('button', { name:'末步', exact:true }).click();
  await expect(page.getByTestId('replay-result')).toContainText('红方获胜');
  await page.keyboard.press('Escape');
  await expect(page.locator('.cell[data-cell-state="hidden"]')).toHaveCount(30);
});
