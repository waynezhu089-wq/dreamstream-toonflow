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
