# Flip Xiangqi

翻牌中国象棋本地双人 3D 对局。

项目基于标准中国象棋规则，加入“将/帅固定明置，其余 30 枚棋子全局随机暗置、翻牌算一步”的变体玩法。`v0.5.0` 将棋盘、棋子与所有核心交互全面迁移至 Three.js 3D 场景，形成真正可游玩的 3D 主现法体验。

当前版本已经覆盖：

- Phase 1：项目骨架、规则数据模型、纯规则引擎边界
- Phase 2：随机暗置开局、翻牌动作、回合切换
- Phase 3：全部棋种的标准走法、暗子阻挡、不可直接吃暗子、炮架判定
- Phase 4：将军判定、照将限制、非法自杀着拦截、终局结算
- Phase 5：本地双人交互界面、状态提示、吃子区、重新开局
- v0.5：真正 3D 对局体验——棋盘、棋子实体化、翻牌/移动/吃子动画、镜头切换、发布收口

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

构建已将 Three.js 运行时拆分为独立 chunk，以降低首屏阻塞并消除默认的单文件 chunk warning。`three-core` vendor chunk 约 724 kB，属于 3D 场景可接受的非阻塞成本；Vite 警告阈值已按该情况调整到 750 kB。

## 交互说明

- 点击暗子：翻牌，消耗整回合
- 点击己方明子，再点击目标格：尝试移动/吃子
- 非法着法会在右侧状态面板显示原因
- 对局结束后可点击“重新随机开局”或“再来一局”开始下一局

## 3D 体验边界

- 棋盘主区域采用 Three.js 全 3D 场景渲染
- 棋子具备翻牌、移动、吃子与选中动画
- 回合切换时相机会平滑转到当前行棋方视角
- 仍不包含 legal-move / highlighted-targets 提示（除非后续单独改方向）
- 不包含联网、AI、账号体系

## 文档

- [v0.5.0 版本说明](docs/releases/v0.5.0.md)
- [v0.4.0 版本说明](docs/releases/v0.4.0.md)
- [游戏玩法说明](docs/gameplay-rules.md)
- [开发分阶段规划](docs/development-roadmap.md)
- [Multica Agent 工作流](docs/agent-workflow.md)
- [PHASE1-5 实施计划](docs/plans/2026-04-14_phase1-5-mvp-implementation.md)
