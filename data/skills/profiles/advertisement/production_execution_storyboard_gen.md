---
name: production_execution_storyboard_gen_advertisement
description: Generate advertisement storyboard images from approved storyboard items.
---

# 广告分镜图生成

根据已确认的分镜项生成或准备分镜图。

- 以广告分镜中的产品、动作、场景和构图为准。
- 保持产品、人物、场景和品牌视觉连续。
- 包装、Logo、结构、颜色等品牌关键元素不得擅自改写。
- 参考图存在时优先使用参考图。
- 对无法由当前模型可靠呈现的文字、Logo或细小包装信息，应标记为后期/编辑处理，不虚构。
- 未获得用户生成授权时，只准备提示词和引用关系，不触发媒体生成。


## 强制工序与资产依据

Brief + 已确认 Asset Plan → Director Plan → Storyboard Table → Storyboard Panel → Supervisor Review → 通过后 Storyboard Image Generation → Video Preparation/Generation。

- 正式资产语义只取当前 projectId + scriptId 的后端已确认 Asset Plan 有效绑定：assetKey、name、category、required、sourcePolicy、assetId、ready。使用 get_advertisementAssetPlan 或 get_flowData("assets") 读取，不把工作区历史、未绑定或重复资产当作已确认素材。
- associateAssetsIds 使用返回的真实 assetId（id 是兼容别名），不得使用 assetKey、计划项序号或猜测的 ID。
- Director Plan 之前禁止自动生成辅助资产。导演规划发现缺少 AI 辅助资产时，返回 Asset Preparation 补充清单、绑定并重新满足 Gate，再继续规划；Production 不自行补造资产。
- Director Plan、Storyboard Table、Storyboard Panel 和 Supervisor Review 是文本策划工序。图片/视频模型为空不阻塞这些工序，不伪造模型；只在真正图片/视频生成时按 point-of-use 检查对应模型。
- Supervisor Review 必须针对当前导演规划、分镜表和分镜面板明确通过。监督前或监督未通过时禁止生成分镜图；修改上述策划内容后必须重新监督，不沿用旧通过结论。生成成功不等于监督通过。
- 监督通过后仍需用户生成授权，才能进入图片生成；缺模型时提示配置并保留已完成的文本策划。视频随后进入 Video Preparation/Generation，无付费调用授权时做准备后暂停，不删除工序。
