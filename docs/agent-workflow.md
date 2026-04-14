# Multica Agent Workflow

本仓库内与代码相关的 issue，统一按以下规则执行：

## 角色分工

- Master Agent 只负责规划、拆解、指派、跟踪、结果回收。
- Codex / local coding agent 负责代码实现、调试、改文件、运行代码相关测试、提交 git commit。

## 执行要求

- 所有 coding issue 必须先在 Multica 中明确目标、范围、验证标准，再交由 Codex 执行。
- 代码相关工作不能只停留在 working tree；完成标准之一是形成可审计的 git commit。
- 如需补充说明、验证结果或交付状态，优先通过 Multica issue comment 留痕。

## 交付检查

- 修复或功能改动对应的测试需要实际执行并检查结果。
- 如任务要求构建验证，必须实际运行构建命令并检查退出状态。
- 提交前 `git status` 应为空，或仅剩与当前任务无关且已说明的改动。
