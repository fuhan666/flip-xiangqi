# Flip Xiangqi

翻牌中国象棋本地双人对局。

项目基于标准中国象棋规则，加入“将/帅固定明置，其余 30 枚棋子全局随机暗置、翻牌算一步”的变体玩法。棋盘以标准 9×10 网格做纯 2D DOM 渲染，点击格子完成翻牌与走子。

当前版本已经覆盖：

- Phase 1：项目骨架、规则数据模型、纯规则引擎边界
- Phase 2：随机暗置开局、翻牌动作、回合切换
- Phase 3：全部棋种的标准走法、暗子阻挡、不可直接吃暗子、炮架判定
- Phase 4：将军判定、照将限制、非法自杀着拦截、终局结算
- Phase 5：本地双人交互界面、状态提示、吃子区、重新开局
- 纯 2D 棋盘渲染：标准 9×10 网格、语义化交互按钮与无障碍标签

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

构建为标准 Vite + React 流程，不包含 3D 相关依赖、拆包清单或特调的 chunk 警告阈值。

## 交互说明

- 点击暗子：翻牌，消耗整回合
- 点击己方明子，再点击目标格：尝试移动/吃子
- 非法着法会在右侧状态面板显示原因
- 对局结束后可点击“重新随机开局”或“再来一局”开始下一局

## 体验边界

- 棋盘主区域为纯 2D 网格渲染（DOM 按钮，无 3D 场景与动画）
- 当前为可交互的基础 2D 呈现，不含视觉特效与动效升级
- 仍不包含 legal-move / highlighted-targets 提示（除非后续单独改方向）
- 不包含联网、AI、账号体系

## 文档

- [v0.5.0 版本说明](docs/releases/v0.5.0.md)
- [v0.4.0 版本说明](docs/releases/v0.4.0.md)
- [游戏玩法说明](docs/gameplay-rules.md)
- [开发分阶段规划](docs/development-roadmap.md)
- [Multica Agent 工作流](docs/agent-workflow.md)
- [PHASE1-5 实施计划](docs/plans/2026-04-14_phase1-5-mvp-implementation.md)
