---
name: production_execution_storyboard_table_advertisement
description: Build an advertisement storyboard table.
---

# 广告分镜表

将广告脚本/Brief和导演计划转换为完整分镜表。

## 审核口径

每个镜头至少明确：
- 序号
- 画面描述
- 时长
- 景别
- 运镜
- 台词/字幕/旁白
- 音效
- 关联资产

## 广告要求

- 总时长不得无故超过项目目标时长。
- 前3秒应快速建立注意力或核心信息。
- 每个镜头都必须服务于卖点、证明、产品展示、品牌记忆或CTA。
- 产品外观和品牌信息必须忠于已有素材。
- CTA必须明确但不能虚构价格、优惠、资质或效果。
- 没有明确证据时，不生成“第一、唯一、治愈、100%有效”等绝对化宣称。
- 若平台为竖屏，重要主体和字幕预留安全区域。


## 强制工序与资产依据

Brief + 已确认 Asset Plan → Director Plan → Storyboard Table → Storyboard Panel → Supervisor Review → 通过后 Storyboard Image Generation → Video Preparation/Generation。

- 正式资产语义只取当前 projectId + scriptId 的后端已确认 Asset Plan 有效绑定：assetKey、name、category、required、sourcePolicy、assetId、ready。使用 get_advertisementAssetPlan 或 get_flowData("assets") 读取，不把工作区历史、未绑定或重复资产当作已确认素材。
- associateAssetsIds 使用返回的真实 assetId（id 是兼容别名），不得使用 assetKey、计划项序号或猜测的 ID。
- Director Plan 之前禁止自动生成辅助资产。导演规划发现缺少 AI 辅助资产时，返回 Asset Preparation 补充清单、绑定并重新满足 Gate，再继续规划；Production 不自行补造资产。
- Director Plan、Storyboard Table、Storyboard Panel 和 Supervisor Review 是文本策划工序。图片/视频模型为空不阻塞这些工序，不伪造模型；只在真正图片/视频生成时按 point-of-use 检查对应模型。
- Supervisor Review 必须针对当前导演规划、分镜表和分镜面板明确通过。监督前或监督未通过时禁止生成分镜图；修改上述策划内容后必须重新监督，不沿用旧通过结论。生成成功不等于监督通过。
- 监督通过后仍需用户生成授权，才能进入图片生成；缺模型时提示配置并保留已完成的文本策划。视频随后进入 Video Preparation/Generation，无付费调用授权时做准备后暂停，不删除工序。
