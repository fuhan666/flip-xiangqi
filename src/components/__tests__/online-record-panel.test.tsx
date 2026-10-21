import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OnlineRecordLibrary } from '../OnlineRecordPanel.js';
import { buildFinishedMatchRecord } from '../../../server/finished-records.js';
import { createMatch, finalizeMatch } from '../../network/match.js';
import { buildStartParameters, createLobbyState } from '../../network/lobby.js';
import type { RoomConnection } from '../../network/client.js';

function settledRecord() {
  const startParameters = buildStartParameters({
    roomId: 'room-1',
    host: { memberId: 'host-1', name: '房主' },
    guest: { memberId: 'guest-1', name: '客人' },
    settings: { ...createLobbyState().settings, sidePreference: 'host-red', locked: true },
    hostSide: 'red',
  });
  const match = finalizeMatch(createMatch({ matchId: 'm1', seed: 2, startParameters }), 'red', 'resignation', 5_000);
  const server = buildFinishedMatchRecord(match);
  return {
    summary: { matchId: 'm1', endedAt: 5_000, expiresAt: 5_000 + 1_800_000 },
    result: { matchId: 'm1', requestId: 'srv-1', expiresAt: 5_000 + 1_800_000, ...server },
    records: [{ matchId: 'm1', endedAt: 5_000, expiresAt: 5_000 + 1_800_000 }],
  };
}

function mockClient(): RoomConnection {
  return { requestGameRecord: vi.fn().mockReturnValue({ ok: true }) } as unknown as RoomConnection;
}

describe('OnlineRecordLibrary', () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('列出本房终局并在点选后请求服务器归档', () => {
    const client = mockClient();
    const { records } = settledRecord();
    render(<OnlineRecordLibrary client={client} perspective="red" recordError={null} recordResult={null} records={records} />);
    expect(screen.getByTestId('online-record-list')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('online-record-entry-m1'));
    expect(client.requestGameRecord).toHaveBeenCalledWith('m1');
    expect(screen.getByTestId('online-record-loading')).toBeInTheDocument();
  });

  it('复制的是服务器返回的原文，不复用本地制谱结果', async () => {
    const { records, result } = settledRecord();
    render(
      <OnlineRecordLibrary
        client={mockClient()}
        perspective="red"
        recordError={null}
        recordResult={result}
        records={records}
      />,
    );
    fireEvent.click(screen.getByTestId('online-record-entry-m1'));
    expect(screen.getByTestId('online-record-ready')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '导出棋谱' }));
    fireEvent.click(screen.getByRole('button', { name: '复制文本' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(result.text));
  });

  it('过期或无权时给出明确原因且不提供导出', () => {
    const { records } = settledRecord();
    render(
      <OnlineRecordLibrary
        client={mockClient()}
        perspective="red"
        recordError={{ matchId: 'm1', code: 'UNAVAILABLE', message: '棋谱不存在或已过期' }}
        recordResult={null}
        records={records}
      />,
    );
    fireEvent.click(screen.getByTestId('online-record-entry-m1'));
    expect(screen.getByTestId('online-record-error')).toHaveTextContent('棋谱不存在或已过期');
    expect(screen.queryByRole('button', { name: '导出棋谱' })).not.toBeInTheDocument();
  });

  it('没有未过期记录时不渲染入口', () => {
    render(<OnlineRecordLibrary client={mockClient()} perspective="red" recordError={null} recordResult={null} records={[]} />);
    expect(screen.queryByTestId('online-record-list')).not.toBeInTheDocument();
  });
});
