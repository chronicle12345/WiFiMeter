# WiFiMeter 文档

简体中文 | [English](README.en.md)

下载、功能演示和安装步骤见[项目首页](../README.md)。下面按使用和开发时常见的需要列出文档。

## 使用

- [悬浮窗](FLOATING_WINDOW.zh-CN.md)：查看实时网速和应用用量，调整位置、形状与贴边隐藏。
- [域名与连接](CONNECTION_MONITORING.zh-CN.md)：接入本机 Clash / Mihomo 控制器，搜索域名，查看所属应用和路由。
- [数据迁移与恢复](MIGRATION.zh-CN.md)：导入旧版记录、制作完整备份、使用 WebDAV，以及恢复数据。
- [Windows 应用流量采集](WINDOWS_APP_CAPTURE.zh-CN.md)：开启应用统计，了解权限要求和采集范围。
- [Linux 应用流量采集](LINUX_APP_CAPTURE.zh-CN.md)：配置 eBPF 采集与权限。
- [Linux 应用图标](LINUX_APPLICATION_ICONS.zh-CN.md)：了解应用名称和图标如何匹配。
- [更新记录](../CHANGELOG.md)与[平台支持情况](PACKAGING-MATRIX.zh-CN.md)：查看版本变化和当前发布目标。

## 开发

- [开发流程](DEVELOPMENT.zh-CN.md)：分支、提交、审查和文档维护约定。
- [项目架构](ARCHITECTURE.zh-CN.md)：界面、桌面宿主和采集后端如何分工。
- [数据协议](../contracts/README.zh-CN.md)：通信字段、字节计数和兼容要求。
- [构建与打包](../packaging/README.zh-CN.md)：准备依赖，从源码运行并生成安装包。
- [测试指南](TESTING.zh-CN.md)：按改动选择检查，区分浏览器测试和原生验证。
- [CI 与发布](PACKAGING-MATRIX.zh-CN.md)：构建矩阵、产物检查和发布步骤。
- [演示素材](DEMO.zh-CN.md)：用模拟流量重新生成 README 的 GIF 和截图。

## 维护文档

中英文文档一同维护。修改前请阅读[双语约定](i18n/README.zh-CN.md)，术语可查[对照表](i18n/terminology.md)。长期设计决定的背景保存在 [Agent Notes](../.agents/notes/README.zh-CN.md)。

发现文档遗漏或操作与说明不一致，可以[提交 Issue](https://github.com/chronicle12345/WiFiMeter/issues)。
