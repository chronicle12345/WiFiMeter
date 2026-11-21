# README 演示与截图

[English](DEMO.md) | 简体中文

README 的 GIF 和截图使用当前界面与模拟流量，依次展示总览、应用实时排行、按月汇总的应用历史、网络额度和深色模式。

## 重新生成素材

先运行 `npm ci --prefix apps/desktop` 安装桌面端依赖。录制还需要 Python 3 和 Pillow（`python -m pip install Pillow`）。Windows 默认使用 Microsoft Edge，其他系统使用 Playwright Chromium。需要时可运行 `npm --prefix apps/desktop exec -- playwright install chromium` 安装 Chromium。

在仓库根目录运行：

```sh
node tools/demo/capture.mjs
```

命令会更新 [assets](assets/) 中的 `demo-zh-CN.gif`、`demo-en.gif`、`screenshot.png`、`screenshot-en.png`、`applications-zh-CN.png` 和 `applications-en.png`。中间帧保存在已忽略的 `del/demo/`，方便检查。Windows 下可设置 `WIFIMETER_BROWSER_CHANNEL=chromium` 改用 Chromium；Python 不在默认路径时，将 `WIFIMETER_DEMO_PYTHON` 设为已安装 Pillow 的 Python 可执行文件路径。

## 数据与录制方式

[fixture.mjs](../tools/demo/fixture.mjs) 基于现有测试样例生成数据，日期固定为 2026 年 11 月 21 日。网络名、应用记录、额度和变化的网速均为模拟数据。界面和 Tauri 桥接脚本来自应用源码，通信响应由内存中的样例提供。录制使用全新的无界面浏览器配置，页面请求只允许访问本地素材服务器，不启动原生宿主或采集器，不打开用户数据库，也不读取本机应用图标。

更新演示时，在 `fixture.mjs` 中修改样例，在 [capture.mjs](../tools/demo/capture.mjs) 中调整录制步骤。中英文版本使用相同场景和数值。界面中的实测、原生采集等标签来自应用本身，README 图注说明所有展示数据均为模拟值。演示用于介绍界面，不能作为原生采集准确性的验证。

## 检查

播放两种语言的 GIF，并查看静态截图，检查文字是否清楚、切页是否完整、明暗配色及循环结尾是否正常。确认演示功能存在于当前界面，中英文样例表达一致。

```sh
npm run test:docs
npm run check:docs
```

文档测试检查样例可重复生成、日期筛选，以及不支持的系统操作会被拒绝。应用行为的改动按[测试指南](TESTING.zh-CN.md)选择检查。
