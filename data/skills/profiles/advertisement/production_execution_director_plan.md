---
name: production_execution_director_plan_advertisement
description: Build an advertisement director plan.
---

# 广告导演规划

把当前广告需求整理为可直接进入分镜的导演计划。

## 必须覆盖

- 广告目标
- 目标受众
- 平台/画幅
- 总时长
- 核心卖点
- 必须出现的信息
- 禁止或不可编造的信息
- Hook
- 中段价值展示
- 产品/品牌英雄镜头
- CTA
- 视觉节奏与镜头密度
- 需要引用的关键资产

## 30秒默认节奏

可参考但不要机械套用：
- 0–3s：Hook
- 3–10s：场景/痛点/需求
- 10–22s：产品价值、使用或证据展示
- 22–27s：品牌/产品强化
- 27–30s：CTA

画面结构适配项目当前 `videoRatio`。已知模型能力可作为执行参考；未配置图片/视频模型时继续文本策划，将生成能力核对留到对应生成工序。
避免使用“第几集、章节、悬念收尾”等短剧术语。


## 强制工序与资产依据

Brief + 已确认 Asset Plan → Director Plan → Storyboard Table → Storyboard Panel → Supervisor Review → 通过后 Storyboard Image Generation → Video Preparation/Generation。

- 正式资产语义只取当前 projectId + scriptId 的后端已确认 Asset Plan 有效绑定：assetKey、name、category、required、sourcePolicy、assetId、ready。使用 get_advertisementAssetPlan 或 get_flowData("assets") 读取，不把工作区历史、未绑定或重复资产当作已确认素材。
- associateAssetsIds 使用返回的真实 assetId（id 是兼容别名），不得使用 assetKey、计划项序号或猜测的 ID。
- Director Plan 之前禁止自动生成辅助资产。导演规划发现缺少 AI 辅助资产时，返回 Asset Preparation 补充清单、绑定并重新满足 Gate，再继续规划；Production 不自行补造资产。
- Director Plan、Storyboard Table、Storyboard Panel 和 Supervisor Review 是文本策划工序。图片/视频模型为空不阻塞这些工序，不伪造模型；只在真正图片/视频生成时按 point-of-use 检查对应模型。
- Supervisor Review 必须针对当前导演规划、分镜表和分镜面板明确通过。监督前或监督未通过时禁止生成分镜图；修改上述策划内容后必须重新监督，不沿用旧通过结论。生成成功不等于监督通过。
- 监督通过后仍需用户生成授权，才能进入图片生成；缺模型时提示配置并保留已完成的文本策划。视频随后进入 Video Preparation/Generation，无付费调用授权时做准备后暂停，不删除工序。
