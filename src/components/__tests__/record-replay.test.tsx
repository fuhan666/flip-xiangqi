import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { actions, playedGame } from '../../records/__tests__/fixture';
import { parseRecord, recordText } from '../../records/record';

function opening() { return playedGame().initial; }
async function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.readAsText(blob); });
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('plays -> undoes -> finishes -> copies/downloads -> imports and navigates the same final board', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  const blobs: Blob[] = [];
  const revoke = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: vi.fn((blob: Blob) => { blobs.push(blob); return 'blob:record'; }), revokeObjectURL: revoke });
  const filenames: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { filenames.push(this.download); });
  const { container } = render(<App initialState={opening()} />);
  const play = (action: typeof actions[number]) => {
    if (action.type === 'flip') fireEvent.click(screen.getByTestId(`cell-${action.position.x}-${action.position.y}`));
    else {
      fireEvent.click(screen.getByTestId(`cell-${action.from.x}-${action.from.y}`));
      fireEvent.click(screen.getByTestId(`cell-${action.to.x}-${action.to.y}`));
    }
    act(() => vi.advanceTimersByTime(500));
  };
  for (const action of actions) play(action);
  fireEvent.click(screen.getByRole('button', { name: '悔棋' }));
  expect(screen.queryByRole('button', { name: '导出棋谱' })).not.toBeInTheDocument();
  play(actions[24]);
  fireEvent.click(screen.getByRole('button', { name: '导出棋谱' }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '复制 JSON' })));
  const json = writeText.mock.calls[0][0] as string;
  const record = parseRecord(json);
  expect(record.moves.map((m) => m.stepNumber)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  expect(record.result.reason).toBe('checkmate');
  expect(record.result.durationSeconds).toBe(12.5);
  act(() => vi.advanceTimersByTime(5000));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '复制 JSON' })));
  expect(writeText.mock.calls[1][0]).toBe(json);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '复制文本' })));
  expect(writeText.mock.calls[2][0]).toBe(recordText(record));
  fireEvent.click(screen.getByRole('button', { name: '下载 JSON' }));
  expect(filenames[0]).toBe('flip-xiangqi-25-steps.json');
  fireEvent.click(screen.getByRole('button', { name: '下载 TXT' }));
  expect(filenames[1]).toBe('flip-xiangqi-25-steps.txt');
  expect(blobs.map((b) => b.type)).toEqual(['application/json;charset=utf-8','text/plain;charset=utf-8']);
  act(() => vi.advanceTimersByTime(1000));
  expect(revoke).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
  expect(await blobText(blobs[0])).toBe(json);
  expect(await blobText(blobs[1])).toBe(recordText(record));
  fireEvent.click(screen.getByRole('button', { name: '开始复盘' }));
  let viewer = screen.getByRole('dialog', { name: '棋谱复盘' });
  expect(within(viewer).getByRole('button', { name: '上一步' })).toBeDisabled();
  fireEvent.click(within(viewer).getByRole('button', { name: '下一步' }));
  expect(within(viewer).getByTestId('cell-7-2')).toHaveAttribute('data-recent-action','flip');
  expect(viewer.querySelector('.board-trace-line')).toBeNull();
  fireEvent.click(within(viewer).getByRole('button', { name: '末步' }));
  expect(within(viewer).getByTestId('cell-4-2')).toHaveTextContent('俥');
  expect(within(viewer).getByTestId('cell-4-2')).toBeDisabled();
  expect(viewer.querySelector('[aria-current="step"]')).toHaveTextContent('25.');
  expect(viewer.querySelector('.board-trace-line')).not.toBeNull();
  fireEvent.keyDown(window, { key: 'ArrowLeft' });
  expect(within(viewer).getByTestId('cell-4-2')).toHaveAttribute('data-cell-state','empty');
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByTestId('cell-4-2')).toHaveTextContent('俥');
  const file = { size: json.length, text: async () => json };
  await act(async () => fireEvent.change(screen.getByLabelText('选择 JSON 棋谱'), { target: { files: [file] } }));
  viewer = screen.getByRole('dialog');
  fireEvent.keyDown(window, { key: 'End' });
  expect(within(viewer).getByTestId('cell-4-2')).toHaveTextContent('俥');
  fireEvent.keyDown(window, { key: 'Home' });
  expect(within(viewer).getByTestId('cell-7-2')).toHaveAttribute('data-cell-state','hidden');
  fireEvent.keyDown(window, { key: 'Escape' });
  const before = container.querySelector('.board')?.innerHTML;
  await act(async () => fireEvent.change(screen.getByLabelText('选择 JSON 棋谱'), { target: { files: [{ size: 3, text: async () => '{}' }] } }));
  expect(screen.getByRole('alert')).toHaveTextContent('无法载入棋谱');
  expect(container.querySelector('.board')?.innerHTML).toBe(before);
  fireEvent.change(screen.getByLabelText('选择 JSON 棋谱'), { target: { files: [] } });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

describe('clipboard failure', () => {
  it('offers downloads when both clipboard paths fail', async () => {
    const { GameRecordControls } = await import('../GameRecordControls');
    const { createRecord } = await import('../../records/record');
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) }, configurable: true });
    const record = createRecord(opening(), { ...opening(), winner: 'red' }, { mode:'local',seats:{red:'红',black:'黑'} }, { winner:'red',reason:'resignation',durationSeconds:0,timeBasis:'elapsed' });
    render(<GameRecordControls record={record} onReplay={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name:'导出棋谱' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name:'复制文本' })));
    expect(screen.getByRole('status')).toHaveTextContent('复制失败，请下载');
    expect(screen.getByRole('button', { name:'下载 JSON' })).toBeEnabled();
  });
});
