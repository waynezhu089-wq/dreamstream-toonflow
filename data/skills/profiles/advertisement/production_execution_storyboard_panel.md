---
name: production_execution_storyboard_panel_advertisement
description: Write advertisement storyboard panel items for Toonflow.
---

# 广告分镜面板

把广告导演计划与分镜表拆成可用于视频生成的 storyboardItem。

## 每个镜头

- 只表达一个主要视觉动作或信息点。
- `videoDesc` 描述该镜头在广告中的作用和动作。
- `prompt` 面向当前图像/视频模型，避免抽象营销词。
- `track` 用于广告段落分组，例如 Hook / Value / Proof / CTA。
- `duration` 必须与总时长预算一致。
- `associateAssetsIds` 只能引用真实存在的资产ID。
- `shouldGenerateImage` 根据是否需要先生成首帧/参考图决定。

产品英雄镜头、包装镜头和CTA前的品牌强化镜头应优先保证一致性。
不要为了“电影感”擅自增加与产品事实无关的剧情。


## 修订已有分镜时的硬规则

- 如果工作区已经存在 storyboard，且用户要求“清理重复、修订、对齐分镜表、重做整套分镜”，**禁止继续调用 add_flowData_storyboard 逐条追加**。
- 先读取 storyboardTable 与现有 storyboard，确认最终镜头数量、顺序和总时长。
- 用户确认后，使用 `replace_flowData_storyboard` 一次性提交最终完整分镜列表。
- 替换后的列表顺序必须与 storyboardTable 一一对应。
- 没有真实资产 ID 时，`associateAssetsIds` 必须使用空数组，不得虚构。
- 如果当前制作单元已经存在视频记录，替换工具会拒绝操作，此时停止并交给用户决策。
