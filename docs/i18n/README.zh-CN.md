# 双语文档

[English](README.md) | 简体中文

英文和简体中文具有同等权威性，任一语言都可以先写。参考[术语表](terminology.md)，同步含义、命令、约束和证据。

## 文件与范围

同目录维护 `<name>.md`、`<name>.zh-CN.md` 及生成的 `<name>.i18n.json`。两个 Markdown 文件都提供语言切换，不手动编辑审阅记录。

配对和正文字数限制覆盖非 vendor README/CONTRIBUTING、活跃的 `docs/` 与 `.agents/notes/`，以及 `contracts/`、`backend/platform/`、`packaging/` 中维护的技术文档，包括项目维护的依赖说明。

| 例外 | 约定 |
| --- | --- |
| `AGENTS.md` 及同目录 `CLAUDE.md` | 英文指令源及同步镜像 |
| `CHANGELOG.md` 与历史 `docs/releases/` | 同一文件先英文后中文 |
| [terminology.md](terminology.md) | 单份双语表格 |
| 已归档 Notes | 冻结已审阅的三个文件 |
| vendor 源码及第三方许可证原文 | 保留上游材料 |

共享规则和 Notes 纳入版本控制，个人配置、凭据、会话和诊断继续忽略，详见[开发流程](../DEVELOPMENT.zh-CN.md#共享规则与私人状态)。

## 编辑与审阅

修改任一语言后，对另一版作必要的最小同步。保留标识符、路径、命令、选项、数值、平台限制和运行时契约，各语言自然表达，不逐字硬译。

审阅双语的行为、条件、例外、证据、术语、链接、表格、列表和示例，不得仅为消除报错刷新记录。完成语义审阅后运行：

```sh
npm run docs:pair -- docs/DEVELOPMENT.md --reviewed
npm run check:docs
```

可传入一个或多个 Markdown 路径，任一语言都能定位配对。`--reviewed` 确认已经语义审阅。两版与生成记录一起提交，后续修改先审阅再更新记录。

## 检查能说明什么

本项目有意采用整文件 JSON 记录，保存换行归一为 LF 后的 SHA-256，与按章节记录的 YAML 不能直接互换。摘要发现审阅后的变化，不能证明译文质量、事实或示例正确。

`check:docs` 检查双语记录、标题层级、列表与表格、代码块、链接、活跃 Notes、仓库文件政策、指令镜像和正文字数。工具本身变化后运行 `test:docs`。

上限见 [budgets.json](../../tools/docs/budgets.json)，`npm run docs:budget` 显示用量。先将内容归位、去重和压缩，确需例外时说明理由再调整上限。检查器按实际可见正文执行限制。

命令和工具路径见 [package.json](../../package.json)，[测试指南](../TESTING.zh-CN.md)区分这些检查与运行时验证。

## 指令镜像与归档记录

编辑 `AGENTS.md` 后运行 `npm run docs:instructions`。新 `CLAUDE.md` 优先使用真实符号链接，系统不支持时生成带标记且正文与源文件一致的副本。Linux 上已有的生成副本仍保留为副本。`check:docs` 拒绝缺失或不一致的镜像，本次 Windows 环境将带标记的普通副本纳入版本控制。

`core.symlinks=false` 将受版本控制的符号链接检出为存根时，同步工具会拒绝向该链接条目写入正文。需要恢复真实链接，或明确转换其索引条目。指令文件保持英文，不生成配对记录。

活跃 Notes 使用同样的审阅流程。当前事实进入维护文档后，通过 `npm run notes:archive -- <implemented-note-path>` 归档，保留已实施状态、归档日期及审阅后的三个文件。归档保留历史内容，不参与活跃同步，详见 [Notes 规范](../../.agents/notes/README.zh-CN.md)。
