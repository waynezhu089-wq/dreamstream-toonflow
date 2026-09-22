# Dream Stream Toonflow V0.1 — Windows 本地测试方案

## 目标

先做“开发者测试版”，不急着生成安装包。

测试目标只有一条：

> 新建“通用视频 → 广告视频”项目 → 进入 Production → ProductionAgent 使用广告 Skill。

这一步通过后，再进入正式 Electron 打包和第一条“睿译读”广告制作。

## 安全原则

测试版不会直接使用原 Toonflow 的工作目录。

默认流程会把：

`%APPDATA%\toonflow\data`

复制到：

`%USERPROFILE%\Documents\DreamStream-Toonflow-V0.1\test-userdata\data`

改造版 Electron 通过 `TOONFLOW_DEV_USER_DATA` 指向这个隔离目录。

因此：
- 原版 Toonflow 仍可保留；
- 原数据库不会被测试版直接写入；
- 原模型/云供应商配置通过本地副本复用；
- 任何测试项目只写入副本；
- 数据复制仅发生在本机，不上传。

## 前置条件

Windows 10/11。

需要：
- Git
- Node.js >= 22.12.0（建议 Node 24 LTS）
- npm/npx

不要求全局安装 Yarn；脚本固定使用 Yarn Classic 1.22.22。

## 第一次准备

先把本仓库克隆到任意位置，然后双击：

`scripts\dreamstream\prepare-test.cmd`

脚本会自动：
1. 在 `Documents\DreamStream-Toonflow-V0.1` 创建测试工作区；
2. 获取后端分支 `dreamstream/general-video-v0.1`；
3. 获取前端分支 `dreamstream/general-video-v0.1`；
4. 安装前后端依赖；
5. 复制原 Toonflow data 到隔离测试目录；
6. 把 Dream Stream 广告 Skill 覆盖到测试副本。

如需重新从原 Toonflow 数据制作测试副本：

`powershell -ExecutionPolicy Bypass -File scripts\dreamstream\prepare-test.ps1 -RefreshData`

## 启动测试版

双击：

`scripts\dreamstream\start-test.cmd`

它会启动两个窗口：
1. Toonflow Web Vite 开发服务器，固定端口 `50188`；
2. Toonflow Electron 开发端。

Electron 自己启动后端服务，并通过 Toonflow 协议把真实随机 API 端口告诉前端，因此不需要手工填写 API 地址。

## 首次验收

启动后：
1. 使用测试副本对应的本地账号登录；
2. 新建项目；
3. 项目类型选择“通用视频”；
4. 制作类型应自动显示“广告视频”；
5. 画幅选择 `9:16`；
6. 项目名填：`睿译读首条产品广告`；
7. 项目简介先填睿译读广告 Brief；
8. 选择现有云图片/视频模型；
9. 选择视觉手册和导演手册；
10. 创建并打开项目。

预期：
- 不进入 Novel；
- 不进入 ScriptAgent；
- 自动创建一个兼容 production unit；
- 直接进入 Production；
- Novel/ScriptAgent 菜单对该项目隐藏。

## 第一阶段禁止事项

在界面链路确认通过前：
- 不点击批量图片生成；
- 不点击批量视频生成；
- 不启动付费媒体生成；
- 不覆盖原版 Toonflow 的 AppData；
- 不删除原版安装。

先验证“结构和 Skill 是否正确”，再授权真实生成费用。

## 下一阶段

本地链路 PASS 后：
1. 构建前端 `dist`；
2. 将完整 `dist` 同步到后端 `data/web`；
3. 在 Node >=22.12 环境构建后端；
4. Electron `pack/dist`；
5. 输出 Dream Stream Toonflow V0.1 测试安装包；
6. 用“睿译读首条产品广告”进行完整成片测试。
