# Agent Notes

[English](README.md) | 简体中文

Agent Notes 保存有长期价值的决策理由、落选方案及取舍。当前产品和协议事实由所属指南维护；[开发流程](../../docs/DEVELOPMENT.zh-CN.md)负责工作流程。

## 何时编写和更新

先按机制或模块检索活跃的状态与类别目录。记录之间使用相对 Markdown 链接，不维护全局 INDEX.md。

代码、测试和现有文档无法解释的理由具有长期价值时，在同批变更中新建或更新笔记。未来工作从 proposed 开始，已经交付的决定从 implemented 开始。不涉及长期决定的机械或局部修改无需笔记。

决定未变时更新原有记录，路径、名称、默认值和结构随代码同步。决定改变时新建记录并互相链接。

## 路径与分类

使用 `.agents/notes/<lifecycle>/<class>/yyyy-mm-dd-topic.md`。日期是从 Git 历史核实的首次提出日，移动时保持不变。目录按需创建。

每篇笔记包含英文 `.md`、中文 `.zh-CN.md` 和生成的 `.i18n.json`。状态目录为 `proposed`、`implemented`、`rejected` 和 `archived`。

| 类别 | 范围 |
| --- | --- |
| `feature` | 新增能力 |
| `bug-fix` | 修复缺陷或事故复盘发现的缺口 |
| `simplification` | 不增加能力的删除或合并 |
| `architecture` | 交付源码、模块与运行时边界 |
| `process` | 工具、策略及开发和发布流程 |
| `testing` | 测试基础设施与策略 |

architecture 关注交付的代码，process 关注围绕代码的工具和流程。新增类别须同步修改检查器和本指南。

## 文件格式

前三行严格采用以下格式，随后空一行并添加语言切换链接：

```markdown
# Agent Note: <title>

Status: proposed
```

Status 行仅出现一次，状态与目录一致：`proposed`、`implemented` 或 `rejected — <one-line reason>`。状态行不加日期和括号说明，补充条件写入正文。

提案骨架：

```markdown
## Problem
## Proposal
## Alternatives considered
## Acceptance criteria
## Risks
```

问题应能脱离方案独立说明需求。方案描述计划变更、迁移和待定事项；验收标准说明可观察的完成状态；风险说明可能的失败及主动放弃的能力。

已实施骨架：

```markdown
## Problem
## Decision
## Alternatives considered
## Consequences
```

决定用现在时描述交付事实，影响说明收益和代价。可增加专门技术小节及验证，记录实际证据、限制和覆盖缺口。此状态禁止保留 Proposal、Plan、Migration plan、Acceptance criteria 标题。

否决记录保留原提案正文和所有小节，仅强制要求问题、方案、备选方案。否决结论写入 Status，已有计划、验收标准和风险均保留。

备选方案记录真实选项及各自落选原因，每项用加粗引导的段落或 `### Why not <X>?` 小节。无法核实的历史不能补编。

两种语言的结构和含义对应。机器头部保持英文；中文小节名为问题、方案、备选方案、验收标准、风险、决定、影响、验证。

## 移动与取代

三个文件一起移动，保留日期，更新 Status 和入站链接，并满足目标状态的格式。

proposed → implemented 时，将方案改写为现在时的决定，用交付事实替换计划；将验收标准和风险并入影响，或陈述事实的 Testing/Verification 小节，记录实际结果与缺口。

proposed → rejected 时，在 Status 中写明理由，保留原提案。

部分取代时保留两篇记录并互相链接，更新仍适用的事实。完全吸收后才可删除旧三文件：当前记录须保留全部独有理由、备选方案、影响、必要验证和覆盖缺口。同批修复入站链接，不能让 Git 历史成为理由的唯一副本，也不能将旧记录改写成相反决定。

## 移除功能

只有功能从生产代码、配置、schema、持久化及协议格式、迁移和兼容行为中完全消失，当前指南不再描述为可用，且没有测试将其作为受支持行为时，新增该功能的记录才可合并到移除记录。

仅移除一种传输、默认值、实现或视图属于部分取代；仍有持久数据或兼容处理时，也不算完全移除。

移除记录须保留原始动机、该动机为何已不足以支持保留、移除以外的方案、放弃的能力、重新引入条件和完全移除的证据。证明移除的测试可保留；过时实现清单和验证已删除行为的测试不算当前证据。

## 归档与删除

纯机械或小型界面调整记录可删除整个三文件组，并修复或移除入站链接。局部缺陷修复、性能变更、新能力和实质行为决定，不能仅因规模小而删除。

已实施记录仅在完整交付、不太可能指导未来工作且仍有历史价值时归档。备选方案、归属、保证、持久化及协议语义、安全规则或重新引入条件仍有价值时，继续保留为活跃记录。不按存续时间、字数或数量指标判断。

过时提案转为否决；否决理由仍可避免可能发生且影响重大的错误时保留，否则删除三文件并修复链接。

执行 `npm run notes:archive -- <implemented-note-path>`，将已审阅的三文件移至 `archived/<class>/`，保留 implemented 状态，并在两版第 4 行加入相同的 `Archived: YYYY-MM-DD`。归档日期不得早于首次提出日。仅更改归档元数据和配对记录，并修复入站链接。

归档三文件永久冻结，不得编辑、翻译、排版、移动、删除或重新登记，只能作为历史引用。[notes.cjs](../../tools/docs/notes.cjs)负责归档内容校验。

## 审阅与命令

按[双语约定](../../docs/i18n/README.zh-CN.md)审阅两版后，运行 `npm run docs:pair -- <path> --reviewed`。使用 `npm run check:notes`、`npm run docs:budget` 和 `npm run check:docs` 验证；字数限制见 [budgets.json](../../tools/docs/budgets.json)。
