# Flip Xiangqi

翻牌中国象棋本地双人 3D Beta。

项目基于标准中国象棋规则，加入“将/帅固定明置，其余 30 枚棋子全局随机暗置、翻牌算一步”的变体玩法。`v0.4.0` 当前提供的是 **可游玩的 3D Beta 版本**：规则层仍保持稳定的 position 驱动交互协议，前端在主棋盘区域引入 Three.js 视图，并继续保留语义化点击层与测试友好的 DOM 结构。

当前版本已经覆盖：

- Phase 1：项目骨架、规则数据模型、纯规则引擎边界
- Phase 2：随机暗置开局、翻牌动作、回合切换
- Phase 3：全部棋种的标准走法、暗子阻挡、不可直接吃暗子、炮架判定
- Phase 4：将军判定、照将限制、非法自杀着拦截、终局结算
- Phase 5：本地双人交互界面、状态提示、吃子区、重新开局
- v0.4 Beta：Three.js 棋盘外壳、3D Beta 说明、首屏按需懒加载、发布文档与版本收口

## 本地运行

```bash
npm install
npm run dev
```

默认打开 Vite 本地地址即可开始对局。

## 测试与构建

```bash
npm test
npm run build
```

当前构建已将 Three.js 运行时拆分为独立 chunk，以降低首屏阻塞并消除默认的单文件 chunk warning。保留的 `three-core` 惰性 vendor chunk 约 724 kB，属于 3D Beta 当前可接受的非阻塞成本；Vite 警告阈值已按该已知情况调整到 750 kB。首屏先渲染轻量交互层，再按需加载 3D 场景。

## 交互说明

- 点击暗子：翻牌，消耗整回合
- 点击己方明子，再点击目标格：尝试移动/吃子
- 非法着法会在右侧状态面板显示原因
- 对局结束后可点击“重新随机开局”或“再来一局”开始下一局

## 当前 Beta 边界

- 保留现有规则层与 `onCellClick(position)` 交互约定
- 仍然不包含 legal-move / highlighted-targets 提示
- 不包含完整动画系统或复杂镜头演出
- 3D 视图按需懒加载；测试环境回退到静态占位视图以保证稳定验证

## 文档

- [v0.4.0 版本说明](docs/releases/v0.4.0.md)
- [游戏玩法说明](docs/gameplay-rules.md)
- [开发分阶段规划](docs/development-roadmap.md)
- [Multica Agent 工作流](docs/agent-workflow.md)
- [PHASE1-5 实施计划](docs/plans/2026-04-14_phase1-5-mvp-implementation.md)
