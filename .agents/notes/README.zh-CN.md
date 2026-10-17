# Agent Notes

[English](README.md) | 简体中文

Agent Notes 保存长期决策的理由、真实考虑过的替代方案、代价和必要证据。[开发流程](../../docs/DEVELOPMENT.zh-CN.md)负责分支与审查；当前产品和协议事实由所属指南维护。

## 范围与检索

新建前，先按机制或模块检索活跃笔记。原有决定仍适用时，更新所属记录。只有代码、测试和现有文档无法解释的长期选择才需要新笔记。机械修改、样式及不涉及长期决策的局部改动无需笔记。无法核实的历史理由和未考虑过的方案不能补写。

按状态和类别目录浏览，或使用仓库搜索。不要维护全局 INDEX.md。归档记录只作为历史证据，不作为当前指导。

## 路径与生命周期

路径采用 `.agents/notes/<lifecycle>/<class>/yyyy-mm-dd-topic.md`。日期是首次提出日，移动记录时保持不变。用到时再创建目录。每篇活跃笔记都包含 `.zh-CN.md` 对照版和 `.i18n.json` 记录，遵循[双语约定](../../docs/i18n/README.zh-CN.md)。

| 状态 | 含义 |
| --- | --- |
| `proposed` | 尚未实施的决定，包含验收条件和已知风险 |
| `implemented` | 已落地的决定，事实随代码同步 |
| `rejected` | 被否决的提案，其理由仍能避免可能重犯的错误时保留 |
| `archived` | 已完成、仅有历史价值且不再指导当前工作的已落地决定 |

| 类别 | 主题 |
| --- | --- |
| `feature` | 产品能力与行为 |
| `bug-fix` | 长期适用的缺陷修复策略 |
| `simplification` | 删除或合并及其取舍 |
| `architecture` | 已发布模块、数据与协议的边界 |
| `process` | 开发、工具与发布规则 |
| `testing` | 验证策略与覆盖范围 |

## 格式与维护

两种语言保留相同的机器可读开头：

```markdown
# Agent Note: <title>

Status: implemented
```

提案使用 `proposed`，否决使用 `rejected — <reason>`。空一行后添加语言切换链接。中英文小节顺序对应。

| 状态 | 必需小节 |
| --- | --- |
| 提案或否决 | Problem、Proposal、Alternatives considered、Acceptance criteria、Risks |
| 已落地 | Problem、Decision、Alternatives considered、Consequences |

对应中文小节名为问题、方案、备选方案、验收标准、风险、决定、影响。已落地决定描述当前事实，实际证据放在 Verification 小节。实施完成时替换提案标题和计划。路径、默认值和名称与代码同批更新。决定或理由改变时，另写笔记并互相链接。

## 验证与归档

`npm run check:notes` 检查生命周期与封印，`npm run check:docs` 执行完整文档检查。核对两种语言后，再执行 `npm run docs:pair -- <path> --reviewed`。[预算配置](../../tools/docs/budgets.json)限制每篇笔记的字数；`npm run docs:budget` 显示用量。

只有不再指导活跃工作的已落地记录才能归档。执行 `npm run notes:archive -- <implemented-note-path>`，命令移动三个文件，保留 implemented 状态，添加相同归档日期并记录归一 LF 后的 SHA-256 封印；目标已存在时拒绝操作。同批更新活跃文档中的入站链接。

归档清单相对于 Git 基线只增不改：本地使用 HEAD，CI 通过 DOCS_BASE_REF 提供 PR 基线或推送前提交。明确指定的基线无法读取时检查失败。封存的三个文件不能修改、删除或重新登记；换行归一支持 Windows 检出。封印只能确认登记内容未变，无法判断语义正确性。
