# Dream Stream Toonflow V0.1 — Windows 本地测试方案

## 当前阶段

第一轮只跑“浏览器开发者测试版”，暂不打 Electron 安装包。

目标只有一条：

> 新建“通用视频 → 广告视频”项目 → 直接进入 Production → ProductionAgent 使用广告 Skill。

这条链路通过后，再构建集成前端并打 Electron 测试安装包。

## 为什么先用浏览器模式

浏览器模式可以先避开 Electron 原生模块 ABI、electron-rebuild 和安装包签名等问题。

当前测试版：
- 后端固定运行在 `http://127.0.0.1:10588`
- 前端 Vite 固定运行在 `http://127.0.0.1:50188`
- 前端源码默认 API 地址就是 `http://localhost:10588/api`

## 安全原则

测试版不会直接使用原 Toonflow 的工作数据目录。

默认流程会把：

`%APPDATA%\toonflow\data`

复制到：

`%USERPROFILE%\Documents\DreamStream-Toonflow-V0.1\test-userdata\data`

后端通过 `TOONFLOW_DATA_DIR` 环境变量只读写这个隔离副本。

因此：
- 原版 Toonflow 可以继续保留；
- 原数据库不会被测试版直接写入；
- 原云模型/供应商配置通过本机副本复用；
- 测试项目只写入副本；
- 数据复制仅发生在你的电脑上，不上传；
- Dream Stream 的广告 Skill 会覆盖到测试副本，不改原版 Skill。

> 第一次执行准备脚本前，建议先退出正在运行的原版 Toonflow，再复制数据库。

## 前置条件

Windows 10/11。

需要：
- Git
- Node.js >= 22.12.0（建议 Node 24 LTS）
- npm / npx

不要求全局安装 Yarn；脚本固定使用 Yarn Classic 1.22.22。

## 第一次准备

获取本仓库后，双击：

`scripts\dreamstream\prepare-test.cmd`

脚本会自动：
1. 在 `Documents\DreamStream-Toonflow-V0.1` 创建测试工作区；
2. 获取后端 `dreamstream/general-video-v0.1` 分支；
3. 获取前端 `dreamstream/general-video-v0.1` 分支；
4. 安装前后端依赖；
5. 复制原 Toonflow data 到隔离测试目录；
6. 把 Dream Stream 广告 Skill 覆盖到测试副本。

需要重新从原 Toonflow 复制一份干净测试数据时：

`powershell -ExecutionPolicy Bypass -File scripts\dreamstream\prepare-test.ps1 -RefreshData`

## 启动测试版

双击：

`scripts\dreamstream\start-test.cmd`

它会：
1. 启动隔离后端，端口 `10588`；
2. 后端使用测试目录中的 `db2.sqlite / vendor / models / skills / oss`；
3. 启动 Toonflow Web Vite，端口 `50188`；
4. 自动打开浏览器 `http://127.0.0.1:50188`。

关闭两个 PowerShell 窗口即可停止测试版。

## 第一轮验收

登录后：

1. 新建项目；
2. 项目类型选择 **通用视频**；
3. 制作类型应自动显示 **广告视频**；
4. 项目名：`睿译读首条产品广告`；
5. 画幅：`9:16`；
6. 项目简介填写睿译读广告 Brief；
7. 选择你原 Toonflow 中已经配置好的云图片模型和视频模型；
8. 选择视觉手册和导演手册；
9. 创建并打开项目。

预期：
- 不进入 Novel；
- 不进入 ScriptAgent；
- 自动建立一个兼容 production unit；
- 直接进入 Production；
- Novel/ScriptAgent 菜单对该项目隐藏。

## 第一轮只验证结构

在我们确认广告 Profile 真正生效之前：

- 不点击批量图片生成；
- 不点击批量视频生成；
- 不执行任何付费媒体生成；
- 可以允许文本模型生成导演规划/分镜，但第一次操作前先确认当前文本模型费用；
- 不删除原版 Toonflow；
- 不覆盖原 AppData。

## PASS 后的打包阶段

浏览器测试 PASS 后再做：

1. 构建 `dreamstream-toonflow-web/dist`；
2. 将完整 `dist` 同步到后端 `data/web`；
3. 在 Node >=22.12 环境构建后端 `data/serve/app.js` 与 Electron main；
4. 执行 Electron `pack/dist`；
5. 输出 Dream Stream Toonflow V0.1 测试安装包；
6. 用“睿译读首条产品广告”跑完整生产链和成片。
