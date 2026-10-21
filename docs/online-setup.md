# 在线匿名多房间入口

单一 HTTPS/WSS 地址承载多个匿名房间：两名玩家拿到同一个邀请链接即可完成建房、加入、就绪、对战与结算。局域网入口（`npm run dev` / `npm start`）保持不变，两者互不影响。

## 与局域网入口的区别

| | 局域网入口 | 在线入口 |
| --- | --- | --- |
| 地址 | 每房一个 `IP:端口`（HTTP/WS） | 一个 HTTPS/WSS 地址承载多个房间 |
| 身份 | 房主 `hostToken` / 客人全局恢复凭据 | 服务器签发的匿名 cookie |
| 房间寻址 | 房主机器端口 | `/online/rooms/:roomId` |
| 页面 | `http://IP:端口` | `https://<公网地址>/online` |
| 本机控制 API | 提供 `/api/room/*` | **不提供、不代理**（明确 404） |

在线入口不复用局域网的控制接口，也不会把 `localhost` 的本机 API 暴露到公网。

## 本地自签证书

在线入口只接受 HTTPS，缺少证书或证书无效会直接启动失败，不会退回 HTTP。

```bash
mkdir -p .certs
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout .certs/key.pem -out .certs/cert.pem \
  -days 2 -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

`.certs/` 已在 `.gitignore` 中，不要提交私钥。

让本机浏览器信任这张测试证书（可选，但浏览器会对自签证书报警）：

- macOS：`sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain .certs/cert.pem`
- 其他系统：把 `cert.pem` 导入系统/浏览器受信任根证书后重启浏览器。

仅本机验证时可以跳过信任步骤，在浏览器里手动接受一次证书警告。

## 启动

```bash
npm run build          # 生成 dist/ 静态产物与 dist-server/ 服务端
npm run start:online   # 需要先用 npm run build 构建
# 或：npm run dev:online（先构建，再用 tsx 直接跑同一入口）
```

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ONLINE_PORT` | `8443` | 监听端口 |
| `ONLINE_HOST` | `0.0.0.0` | 监听地址 |
| `ONLINE_PUBLIC_ORIGIN` | `https://localhost:<port>` | 对外地址，也是 Origin 校验值；分享给他人的链接基于它 |
| `ONLINE_TLS_KEY` | 无（必需） | TLS 私钥路径 |
| `ONLINE_TLS_CERT` | 无（必需） | TLS 证书路径 |
| `ONLINE_STATIC_DIR` | `dist` | 静态产物目录 |

示例：

```bash
ONLINE_PORT=8443 \
ONLINE_PUBLIC_ORIGIN=https://localhost:8443 \
ONLINE_TLS_KEY=.certs/key.pem \
ONLINE_TLS_CERT=.certs/cert.pem \
npm run start:online
```

启动后打开 `https://localhost:8443/online`：

1. 点「创建房间」，页面会跳到 `/online/rooms/<roomId>` 并展示邀请链接；
2. 把邀请链接发给对手，对方打开后以客人身份进入；
3. 双方就绪后由房主开始对局；
4. 刷新页面会以同一匿名身份恢复原席位（房主仍是房主，客人仍是客人）。

`ONLINE_PUBLIC_ORIGIN` 必须与浏览器实际访问的地址一致（含端口），否则 API 与 WebSocket 的 Origin 校验会拒绝请求。

## 身份与权限模型

- **匿名凭据**：首次进入时 `POST /api/online/session` 由服务器签发 256 bit 随机凭据，只保存在 `__Host-flip_anon` cookie（`HttpOnly`、`Secure`、`SameSite=Lax`、`Path=/`、无 `Domain`）。服务器只保存摘要，进程重启即全部失效。
- **身份 / 成员 / 连接三层分离**：`identityId` 由凭据解析；成员席位（房主/客人/旁观）由房间会话分配；每次连接有独立 `connectionId`。重连保持身份与席位、只替换连接。
- **不信任客户端自报**：在线握手 `online.hello` 只带房间号，载荷出现 `role` / `name` / `token` / `resumeToken` / `identityId` / `memberId` 一律按非法报文拒绝。客户端也无法用 LAN 的 `hello` 或 `hostToken` 在在线房间落座。
- **邀请链接只含公开房间号**：链接与房间号不携带房主控制或重连密钥；权限来自浏览器 cookie 与服务器成员记录。
- **刷新与重连**：掉线只释放传输、不释放席位；同一浏览器重新打开房间链接即以原成员身份恢复。匿名凭据失效（例如服务重启）时明确返回 401，页面提示「原席位无法恢复」，需用户显式开始新的匿名会话。

## 多房间与幂等

- 每个房间是一个独立 `RoomSession`，按 `roomId` 在同进程注册与路由；关闭一个房间不影响其他房间与共享监听器。
- `POST /api/online/rooms` 需要 `requestId`：同一身份的同一 `requestId` 并发或重试只创建一个房间，返回同一 `roomId`；同一键携带不同参数返回 409；房间关闭后同键重试返回已关闭结果，不会复活房间。
- WebSocket 连接在升级时即绑定路径中的房间；信封里指向其他房间的心跳、同步或动作都会被 `room-id-mismatch` 拒绝。
- 只有建房者身份能关闭自己创建的房间（`POST /api/online/rooms/:roomId/close`）。

## 资源与生命周期边界

- 全部状态在内存：不引入数据库或 Redis；进程重启会结束进行中的对局与房间。
- 房主显式退出会关闭房间；刷新/断线只保留席位。空房/终局房间的定时回收、邀请分享 UI、大厅列表、手机适配、多核路由与限流压测属于后续阶段。
- 本入口不会反向代理任意 LAN HTTP/WS：HTTPS 页面只连接同源 WSS。

## 验证

```bash
npm test
npm run build
```

自动化测试覆盖：匿名凭据签发/校验与 cookie 属性、建房幂等、可信准入与席位恢复、单 HTTPS 地址下两个房间并发完成对局（真实 API + 真实 WSS + 独立 cookie）、拒绝矩阵（无凭据/坏 Origin/未知房间/LAN 入口/伪造身份/跨房/旁观越权）、关闭单房不影响共享监听器、出站消息不含密钥与暗子身份。

测试中的 HTTPS/WSS 使用运行时生成的自签证书，客户端显式信任该证书，不关闭 TLS 校验。
