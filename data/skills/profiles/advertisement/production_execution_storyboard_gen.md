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


## Storyboard Image Production Mode

每镜新增或整套替换时必须明确提交 productionMode，不再用 shouldGenerateImage 推断生产方式。保留 shouldGenerateImage 仅供旧链路兼容。

- REAL_ASSET_DIRECT：明确指定 primaryAssetId，真实素材原图直接作为镜头输出，不调用 AI。禁止把 associateAssetsIds 第一项猜作主素材。
- AI_TEXT_TO_IMAGE：纯文生图，primaryAssetId=null、referenceAssetIds=[]、referenceAssetGroupIds=[]，进入现有共享图片主干。有关联资产不表示已消费参考图。
- AI_REFERENCE_GENERATE：普通参考输入由 referenceAssetIds / referenceAssetGroupIds 表达；本阶段尚未实现，返回 CAPABILITY_INPUT_UNSUPPORTED，不能忽略参考降级文生图。
- REAL_AI_COMPOSITE：保存真实 primaryAssetId 和生产意图，但本阶段需要尚未实现的 Composite Capability，不能当作已完成。
- 真实 UI、Logo、包装文字、产品标签与界面需要像素真实性时，使用 REAL_ASSET_DIRECT 或 REAL_AI_COMPOSITE，不得经 AI_REFERENCE_GENERATE 重画后冒充真实素材。
- promptSkillId、promptSkillVersion、capabilityId 可为空；保留已有值，改 Prompt 不等于固定同一种 Skill。capabilityId 是能力标识，禁止写 Comfy 节点 ID；本阶段未接入 Comfy，不能宣称其 Capability 可调用。
- 组引用暂用稳定、不透明的字符串 ID 列表保存；未实现组解析与生成，不编造组 ID。批量替换时逐镜完整保留七个生产字段，单项编辑省略字段表示保留，null/空数组表示显式清除。
- 生产接口接受批量镜头 ID，初始 HTTP 成功仅表示接收调度；以逐镜最终 state/reason 为准。未实现能力的失败不是图片生产成功，支持只重试选定镜头。
