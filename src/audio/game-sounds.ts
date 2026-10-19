/**
 * 对局动作 → 音效序列映射。
 *
 * 每一步只安排一个基础声（吃子替代落子），再按需追加至多一个提示声：
 * 终局优先于将军。同一动作绝不会重复发声。
 */

import type { GameHistoryEntry } from '../game/types';
import type { SoundName } from './engine';

export function hasCaptureConsequence(entry: GameHistoryEntry): boolean {
  return entry.consequences.some((consequence) => consequence.type === 'capture');
}

export function hasCheckConsequence(entry: GameHistoryEntry): boolean {
  return entry.consequences.some((consequence) => consequence.type === 'check');
}

export function hasEndgameConsequence(entry: GameHistoryEntry): boolean {
  return entry.consequences.some((consequence) => consequence.type === 'endgame');
}

/** 基础声：吃子替代落子；翻牌始终独立。 */
export function baseSoundForEntry(entry: GameHistoryEntry): SoundName {
  if (entry.action.type === 'flip') {
    return 'flip';
  }
  return hasCaptureConsequence(entry) ? 'capture' : 'move';
}

export interface ActionSoundOptions {
  /** 本步是否结束对局且有胜方（将死 / 吃将 / 认输 / 超时）。 */
  endsGame: boolean;
}

/**
 * 一步权威动作对应的音效序列：
 * 基础声 + 至多一个提示声；终局优先于将军，和棋不发声。
 */
export function soundCuesForHistoryEntry(entry: GameHistoryEntry, options: ActionSoundOptions): SoundName[] {
  const cues: SoundName[] = [baseSoundForEntry(entry)];

  if (options.endsGame) {
    cues.push('victory');
  } else if (hasCheckConsequence(entry)) {
    cues.push('check');
  }

  return cues;
}

/** 无棋步的终局（认输 / 超时 / 断线判负）只播胜利乐句。 */
export function soundCuesForMatchEnd(): SoundName[] {
  return ['victory'];
}
