/**
 * 连接层错误码 → 用户可见文案。
 *
 * 文案遵循「发生了什么 + 为什么 + 现在怎么办」三段式，
 * 不向用户暴露裸错误码。
 */
import type { ErrorCode, LobbyRejectCode, RoomClosedReason } from './protocol.js';

const ERROR_COPY: Record<ErrorCode, string> = {
  INVALID_ADDRESS: '地址无法识别 —— 需要「IP:端口」格式，例如 192.168.1.5:8080 —— 请检查是否漏掉端口或有多余字符',
  CONNECT_TIMEOUT: '连接超时 —— 请确认与房主在同一局域网，且地址端口正确',
  CONNECT_FAILED: '无法连接到房间 —— 可能是地址端口有误、不在同一局域网，或被防火墙拦截 —— 请核对地址后重试',
  HOST_UNAVAILABLE: '本机未运行建房服务 —— 房间由房主电脑承载，加入房间不受影响 —— 请在房主电脑上运行 npm run dev 或 npm start 后再创建房间',
  ALREADY_CONNECTED: '已经连接到一个房间 —— 请先离开当前房间 —— 再加入新的房间',
  INVALID_MESSAGE: '与房间的通信内容不被接受 —— 双方可能运行了不同的客户端 —— 请刷新页面后重试',
  VERSION_MISMATCH: '双方版本不一致，请升级到相同版本后重试',
  UNAUTHORIZED: '加入请求被拒绝 —— 只有房主本人可以执行该操作 —— 请让房主在自己的电脑上操作',
  ROOM_FULL: '房间已关闭或人数已满 —— 一个房间当前只支持一位客人 —— 请让房主先移出离线成员，或稍后再试',
  ROOM_CLOSED: '房间已关闭或人数已满 —— 房主可能已关闭房间 —— 请向房主确认后重新获取地址',
  HANDSHAKE_TIMEOUT: '连接超时 —— 请确认与房主在同一局域网，且地址端口正确',
  INTERNAL_ERROR: '房间内部出现异常 —— 服务端处理出错 —— 请稍后重试，若持续出现请重启建房服务',
};

export function describeErrorCode(code: ErrorCode): string {
  return ERROR_COPY[code] ?? ERROR_COPY.INTERNAL_ERROR;
}

export function describeRoomClosed(reason: RoomClosedReason): string {
  if (reason === 'host-closed') {
    return '房主已关闭房间';
  }
  if (reason === 'host-disconnected') {
    return '房主已离开房间，房间已关闭';
  }
  return '房间已停止服务';
}

/** 大厅操作被拒绝（非致命）的三段式文案，不裸报拒绝码。 */
const LOBBY_REJECT_COPY: Record<LobbyRejectCode, string> = {
  NOT_HOST: '只有房主可以操作该项 —— 分先与局时由房主统一决定 —— 请让房主在自己的电脑上调整',
  LOCKED: '设置已被房主锁定 —— 锁定后不再接受修改，保持开局参数稳定 —— 如需调整，请让房主先解锁',
  INVALID_VALUE: '操作内容不被接受 —— 双方可能运行了不同版本的客户端 —— 请刷新页面后重试',
  STALE_VERSION: '准备状态已过期 —— 设置刚发生了变化，旧的准备不再有效 —— 请确认最新设置后重新点击准备',
  NOT_READY: '还不能开始对局 —— 需要双方都已准备 —— 等待双方准备',
  MEMBER_MISSING: '还不能开始对局 —— 需要双方都在线并留在房间内 —— 请等对手重新加入后再开始',
  ALREADY_STARTED: '对局已经开始 —— 开局参数已冻结，不能重复开始或修改 —— 如需再来一局，请退出后重新建房',
  SPECTATOR_READONLY: '旁观模式下不可操作 —— 你正在观看本局对局 —— 如需对弈，请返回菜单加入或创建房间',
};

export function describeLobbyReject(code: LobbyRejectCode): string {
  return LOBBY_REJECT_COPY[code] ?? LOBBY_REJECT_COPY.INVALID_VALUE;
}
