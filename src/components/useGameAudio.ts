import { useEffect, useRef } from 'react';
import type { GameState, GameViewState } from '../game/types.js';
import type { AcceptedGameAction } from '../network/client.js';
import type { MatchSettlement } from '../network/protocol.js';
import {
  audioEngine,
  hasEndgameConsequence,
  soundCuesForHistoryEntry,
  soundCuesForMatchEnd,
  useAudioBus,
  type AudioEngine,
  type SoundName,
} from '../audio/index.js';

/**
 * 音效运行时：
 * - 首个用户手势内解锁 AudioContext（解锁前到达的声音直接丢弃，不排队补播）；
 * - 把本地音量/静音设置接到播放总线；
 * - 卸载时移除手势监听并取消仍在调度中的声部。
 */
function useAudioRuntime(engine: AudioEngine): void {
  useAudioBus(engine);
  useAudioUnlock(engine);

  useEffect(() => {
    return () => {
      engine.stopAll();
    };
  }, [engine]);
}

/**
 * 在应用外壳注册首个用户手势监听：
 * 尽早解锁音频，使进入对局后立刻能听到对方动作的音效。
 */
export function useAudioUnlock(engine: AudioEngine = audioEngine): void {
  useEffect(() => engine.attach(), [engine]);
}

function actionSoundKey(action: AcceptedGameAction): string {
  const detail =
    action.action.type === 'flip'
      ? `flip:${action.action.position.x},${action.action.position.y}`
      : `move:${action.action.from.x},${action.action.from.y}>${action.action.to.x},${action.action.to.y}`;
  return `${action.stepNumber}:${detail}`;
}

function entryEndsGame(entry: GameViewState['actionHistory'][number]): boolean {
  return entry.winner !== null || hasEndgameConsequence(entry);
}

/**
 * 本地对局音效：
 * 只有新追加的合法动作历史项才发声；首挂载、悔棋、重开与非法操作
 * 都不会补播历史音效，也不受 prefers-reduced-motion 影响。
 */
export function useLocalGameAudio(gameState: GameState, engine: AudioEngine = audioEngine): void {
  useAudioRuntime(engine);

  const historyLengthRef = useRef<number | null>(null);

  useEffect(() => {
    const length = gameState.actionHistory.length;
    const previousLength = historyLengthRef.current;
    historyLengthRef.current = length;

    if (previousLength === null || length <= previousLength) {
      return;
    }

    const entry = gameState.actionHistory[length - 1];
    engine.playCues(soundCuesForHistoryEntry(entry, { endsGame: entryEndsGame(entry) }));
  }, [gameState, engine]);
}

/**
 * 联机对局音效：双端各自本地播放，不占用房间协议带宽。
 *
 * - 只在收到权威动作/广播（`confirmed`）时发声，本地乐观推测不发声，
 *   被服务端拒绝的操作因此不会产生音效；
 * - 按「步号 + 动作」去重，重复广播、断线恢复与同步快照都不重播；
 * - 终局（将死 / 吃将 / 认输 / 超时）单次触发胜利乐句，和棋不发声；
 *   同一步动作与结算不会各播一遍；
 * - 首次进入或恢复已结束对局保持安静。
 */
export function useOnlineGameAudio(
  gameState: GameViewState,
  lastAcceptedAction: AcceptedGameAction | null,
  settlement: MatchSettlement | null,
  engine: AudioEngine = audioEngine,
): void {
  useAudioRuntime(engine);

  const historyLengthRef = useRef<number | null>(null);
  const playedKeysRef = useRef<Set<string>>(new Set());
  const endedRef = useRef<boolean | null>(null);

  useEffect(() => {
    const length = gameState.actionHistory.length;
    const previousLength = historyLengthRef.current;
    historyLengthRef.current = length;

    // 首挂载只登记现状，不补播历史动作的音效。
    const isFirstObservation = previousLength === null;

    if (previousLength !== null && length < previousLength) {
      // 悔棋 / 拒绝回滚 / 新的一局：允许同一局面重新发声。
      playedKeysRef.current.clear();
    }

    const ended = settlement !== null && settlement.winner !== null;
    const previousEnded = endedRef.current;
    endedRef.current = ended;

    const cues: SoundName[] = [];

    const action = lastAcceptedAction;
    if (action && action.confirmed && length > 0) {
      const key = actionSoundKey(action);
      if (!playedKeysRef.current.has(key)) {
        playedKeysRef.current.add(key);
        if (!isFirstObservation) {
          const entry = gameState.actionHistory[length - 1];
          const endsGame = entryEndsGame(entry);
          cues.push(...soundCuesForHistoryEntry(entry, { endsGame }));
          if (endsGame) {
            endedRef.current = true;
          }
        }
      }
    }

    if (ended && previousEnded === false && !cues.includes('victory')) {
      cues.push(...soundCuesForMatchEnd());
    }

    if (cues.length > 0) {
      engine.playCues(cues);
    }
  }, [gameState, lastAcceptedAction, settlement, engine]);
}
