---
name: commit
description: 为当前 Git 仓库创建符合 Conventional Commits 规范的 commit，必要时自动拆分后逐个提交。用户要求 git commit、提交代码、创建 commit、生成 conventional commit message.
---

# Conventional Git Commit

根据当前仓库已经 staged 的改动，生成符合 Conventional Commits 规范的 commit message；需要拆分时，先按逻辑目的拆分，再逐个执行 Git commit。

目标：

- commit message 准确描述实际改动
- 遵循 Conventional Commits
- 一个 commit 尽量只表达一个逻辑目的
- 不提交任务开始时未 staged 的代码，除非用户明确扩大提交范围
- 不修改代码
- 不执行 push

---

# 核心约束

## 只提交 staged changes

默认只处理任务开始时已经进入 Git index 的改动。自动拆分只重新组织这些改动，不扩大提交范围。

先检查：

    git status --short
    git diff --cached --stat
    git diff --cached

不要自动执行：

    git add
    git add .
    git add -A

不要把 unstaged 或 untracked 文件自动加入 commit。

如果没有 staged changes：

停止 commit，并明确告诉用户：

    当前没有 staged changes，未执行 commit。

拆分时允许按下文流程调整暂存区，但不要把原先未 staged 的内容加入提交。

---

# 禁止操作

本 Skill 不允许：

- 修改源代码
- 修改测试
- 新增或删除业务文件
- 自动格式化代码
- 自动执行 lint --fix
- git add
- git reset
- git restore
- git checkout
- git stash
- git rebase
- git merge
- git push
- git push --force
- git commit --amend

除非用户在当前请求中明确要求对应操作，否则不要执行。

需要拆分时，允许使用 `git apply --cached` 等仅调整 Git index 的方式，分批暂存原始 staged changes。该流程默认执行，无需用户再次要求拆分；上述禁止操作仍然适用。

本 Skill 的职责只有：

1. 检查 staged changes
2. 理解改动
3. 必要时按逻辑目的拆分，并为每组生成 commit message
4. 逐组检查暂存内容并执行 git commit
5. 返回 commit 结果

---

# 第一步：读取项目规范

如果仓库存在以下文件，先读取适用的规则：

- `AGENTS.md`
- `CONTRIBUTING.md`
- README 中的 commit 规范
- 项目自己的开发规范

如果项目已经明确规定 commit message 格式：

优先遵循项目规范。

但除非项目明确使用其他规范，否则 commit message 必须符合 Conventional Commits。

---

# 第二步：确认 Git 状态

执行只读检查：

    git status --short

区分：

- staged
- unstaged
- untracked

然后查看 staged diff：

    git diff --cached --stat
    git diff --cached

必要时可以查看：

    git diff --cached --name-status

只根据 staged changes 决定 commit 内容。

---

# 第三步：理解改动目的

不要只根据文件名生成 commit message。

必须阅读 staged diff，并理解：

- 改了什么
- 为什么改
- 改变了什么行为
- 是新增功能还是修复 bug
- 是否只是重构
- 是否只是测试
- 是否只是文档
- 是否涉及构建或 CI
- 是否存在 breaking change

必要时查看相关上下文代码，但保持只读。

---

# Conventional Commits 格式

基本格式：

    <type>[optional scope][!]: <description>

可选：

    <body>

    <footer>

例如：

    feat(auth): add token refresh support

    fix(order): handle null payment result

    refactor(cache): simplify expiration handling

    test(user): add coverage for invalid email

---

# Type 选择规则

必须根据 staged diff 的主要目的选择最准确的 type。

## feat

新增用户可感知的功能或能力。

例如：

    feat(user): support account deactivation

不要因为“新增了一个函数”就自动使用 `feat`。

判断标准是：

**产品或系统能力是否增加。**

---

## fix

修复已有行为中的 bug。

例如：

    fix(order): prevent duplicate payment submission

适用于：

- 空指针修复
- 错误条件判断
- regression
- 异常路径修复
- 数据错误
- API 行为修复

---

## refactor

改变内部实现，但没有新增功能，也没有修复用户可见 bug。

例如：

    refactor(parser): simplify token processing

不要把明显的 bug fix 写成 refactor。

---

## perf

纯性能优化。

例如：

    perf(query): reduce duplicate database lookups

必须确实以性能改善为主要目的。

---

## test

只修改测试，或者主要目的为测试覆盖。

例如：

    test(order): cover payment failure paths

如果业务代码和测试一起修改：

通常应该根据业务代码选择 `feat` 或 `fix`，而不是 `test`。

---

## docs

仅修改文档。

例如：

    docs(api): document pagination parameters

---

## style

只涉及格式、空格、分号等，不改变程序行为。

例如：

    style: format import statements

不要把普通代码重构写成 `style`。

---

## build

构建系统或依赖相关修改。

例如：

    build: upgrade gradle wrapper

    build(deps): update jackson version

---

## ci

CI/CD 配置和脚本修改。

例如：

    ci: add integration test workflow

---

## chore

其他不属于以上类别的维护性工作。

例如：

    chore: update development configuration

不要把 `chore` 当作无法判断时的默认 type。

应先尽量判断真实目的。

---

## revert

回滚以前的 commit。

例如：

    revert: revert "feat(auth): add oauth login"

---

# Scope 规则

scope 是可选的。

只有能够明确判断改动属于某个模块时才添加。

例如：

    feat(auth): ...
    fix(payment): ...
    refactor(cache): ...

scope 可以来自：

- 模块名
- package
- domain
- feature
- service
- subsystem

不要因为修改了某个文件，就机械地把文件名作为 scope。

例如修改：

    UserService.java

不一定要写：

    fix(user-service): ...

更可能是：

    fix(user): ...

如果 scope 不明确：

直接省略。

    fix: handle missing configuration

比错误的 scope 更好。

---

# Description 规则

description 必须：
- 中文
- 简洁
- 准确
- 描述实际修改
- 聚焦“做了什么”
- 不写无意义内容

优先使用 imperative / action 风格。

推荐：

    fix(auth): handle expired refresh tokens

不推荐：

    fix(auth): fixed expired refresh tokens

不推荐：

    fix(auth): some bug fixes

不推荐：

    update code

不推荐：

    changes

不推荐：

    fix issue

避免 description 太长。

通常保持单行清晰即可。

---

# Commit message 语言

优先查看最近的 commit：

    git log -10 --pretty=format:%s

判断项目现有 commit message 语言和格式。

如果项目明显统一使用中文：

可以使用：

    fix(auth): 处理 refresh token 过期场景

如果项目明显使用英文：

继续使用英文。

如果无法判断：

默认使用英文。

无论使用中文还是英文，都必须保持：

    <type>(<scope>): <description>

结构符合 Conventional Commits。

---

# Body 使用规则

简单改动通常不需要 body。

例如：

    fix(user): handle missing profile data

已经足够。

如果仅靠标题无法解释重要背景，可以添加 body。

例如：

    fix(payment): prevent duplicate payment submission

    Reuse the existing idempotency key when retrying a payment
    request so retries do not create additional transactions.

Body 应解释：

- 为什么修改
- 关键行为变化
- 必要的上下文

不要在 body 里重复 diff。

不要生成冗长 commit message。

---

# Breaking Change

如果 staged changes 存在明确的 breaking change，需要使用 `!`。

例如：

    feat(api)!: remove legacy user endpoint

并在 footer 中说明：

    BREAKING CHANGE: `/v1/users` has been removed. Use `/v2/users` instead.

Breaking change 包括但不限于：

- 删除 public API
- 修改不兼容的函数签名
- 删除公开字段
- 修改协议格式
- 修改 event schema
- 修改配置格式且不向后兼容
- 修改数据库/API 契约导致旧消费者无法正常工作

不要仅因为内部实现发生较大变化就使用 `!`。

---

# Footer

只有实际需要时才使用 footer。

例如：

    Refs: #123

或者：

    BREAKING CHANGE: ...

不要凭空生成 issue ID。

如果当前上下文无法确认 issue / ticket：

不要写。

---

# 多种改动混在一起时

检查 staged changes 是否属于同一个逻辑目的。

例如下面通常可以属于一个 commit：

- 修复 UserService bug
- 添加对应 regression test

可以写：

    fix(user): handle missing profile data

但是如果 staged changes 明显包含多个无关目的，例如：

- 修复支付 bug
- 修改 README
- 重构 cache
- 升级依赖

不要生成一个模糊的大 commit，例如：

    chore: update several things

此时先简要说明拆分的逻辑组和提交顺序，然后直接拆分并逐组提交，不要只给出建议后停止，也不要等待用户再次确认。

拆分流程：

1. 记录任务开始时的 staged 内容和工作区状态，确定本次提交范围。
2. 按逻辑目的划分改动；有依赖的改动放在同一组，或按依赖顺序提交。
3. 仅调整 Git index，例如使用 `git apply --cached`，使暂存区每次只包含当前组。支持同一文件内按代码块拆分，不改写工作区文件。
4. 每组提交前查看 `git diff --cached` 并检查内容与分组一致，再生成对应的 Conventional Commit message 并提交。
5. 一组提交成功后继续下一组，直到原始 staged changes 全部提交。
6. 完成后核对：全部提交合起来与原始 staged 内容一致，原先的 unstaged / untracked 内容仍保留，工作区文件内容未因拆分而改变。

同一文件同时有 staged 和 unstaged 改动时，不要使用整文件 `git add` 混入后者。无法在保留原始内容的前提下拆分时，暂停并说明具体原因。

---

# 判断是否需要拆分 commit

只有在修改明显彼此无关时才拆分为多个 commit；需要拆分本身不是停止提交的理由。

不要过度拆分。

以下通常应该保持在同一个 commit：

- 功能实现 + 对应测试
- bug fix + regression test
- API 调整 + 必需的调用方修改
- refactor + 为保持行为所需的测试调整
- config 修改 + 对应代码适配

核心原则：

**一个 commit 表达一个完整的逻辑变化。**

---

# Commit 前检查

执行 commit 前，确认：

1. staged changes 不为空
2. 当前组 staged changes 属于一个合理的逻辑修改
3. commit type 准确
4. scope 如果存在，是明确且有意义的
5. description 准确描述 staged diff
6. 没有凭空生成 issue ID
7. breaking change 已正确标记
8. 当前组没有混入原始提交范围之外的 unstaged / untracked changes

---

# 执行 commit

对于简单 commit：

    git commit -m "<commit-message>"

例如：

    git commit -m "fix(auth): handle expired refresh tokens"

如果需要 body，可以使用安全的多段 message，例如：

    git commit \
      -m "fix(payment): prevent duplicate payment submission" \
      -m "Reuse the existing idempotency key for payment retries."

不要使用交互式编辑器。

不要执行：

    git push

单组 commit 成功后，继续提交剩余分组；全部分组提交并完成结果核对后停止。

---

# Commit 失败处理

如果 commit 失败：

停止后续分组的提交，保留已成功的 commit 和剩余改动，并报告已完成与未完成的分组。不要自动撤销已成功的 commit。

不要绕过安全机制。

例如失败原因是：

- pre-commit hook
- lint
- tests
- commit-msg hook
- GPG signing
- repository policy

不要：

- 使用 `--no-verify`
- 修改代码绕过 hook
- 修改 Git 配置
- 禁用 signing

除非用户明确要求。

应该报告：

- commit 没有成功
- 失败原因
- 哪个检查失败
- 用户下一步需要处理什么

特别禁止默认执行：

    git commit --no-verify

---

# 输出格式

commit 前可以简短说明即将使用的 message：

    Commit message:

    fix(auth): handle expired refresh tokens

然后执行 commit。

成功后输出：

    Commit 成功。

    <commit-hash> fix(auth): handle expired refresh tokens

同时说明：

- committed files 数量
- unstaged changes 是否仍然存在

拆分提交时，逐条列出每个 commit 的 hash 和 message，并汇总提交文件数及剩余工作区改动。

例如：

    Commit 成功。

    a1b2c3d fix(auth): handle expired refresh tokens

    已提交：3 个文件
    工作区仍有 2 个未 staged 文件，本次未包含。

不要输出冗长总结。

---

# 如果用户只要求生成 Commit Message

如果用户明确说：

- 只生成 commit message
- 不要 commit
- 给我 commit message
- generate commit message

那么：

只分析 staged changes 并输出建议 message。需要拆分时，列出分组及各组 message；不调整暂存区，也不执行提交。

不要执行：

    git commit

例如：

    fix(order): prevent duplicate payment submission

---

# 最终硬约束

默认行为：

    原始 staged changes
          ↓
    阅读 staged diff
          ↓
    判断逻辑目的，必要时自动拆分
          ↓
    逐组调整并检查暂存区
          ↓
    Conventional Commit message → git commit
          ↓
    继续下一组，直到全部完成
          ↓
    核对全部提交与原始暂存内容一致
          ↓
    STOP

永远不要自动：

    git add
    git push
    git commit --amend
    git commit --no-verify

Commit 的默认边界是任务开始时已经 staged 的修改；自动拆分只改变分组和提交顺序。
