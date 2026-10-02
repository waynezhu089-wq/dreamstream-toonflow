// Project Agent remains the single conversation surface. Only CHAT and
// VISION_ANALYZE have producers in this experimental phase; the other intents
// reserve routing vocabulary, not execution or production authority.
export type AgentIntent = "CHAT" | "VISION_ANALYZE" | "IMAGE_GENERATE" | "IMAGE_EDIT" |
  "VIDEO_GENERATE" | "ASSET_PROPOSAL" | "SHOT_PROPOSAL";

const visual = /看|视觉|分析|比较|对比|风格|颜色|构图|轮廓|标志|人物|场景|图片|照片|参考图|图像|logo|image|picture|photo|visual|composition|color|reference/i;
const imageGeneration = /(?:生成|画|制作|create|generate|draw)\s*(?:一张|一幅|图片|图像|image|picture)/i;
const videoGeneration = /(?:生成|制作|create|generate)\s*(?:一段|视频|影片|video|clip)/i;

export function routeAgentIntent(message: string, attachedCount: number, priorImageCount: number): AgentIntent {
  if (imageGeneration.test(message)) return "IMAGE_GENERATE";
  if (videoGeneration.test(message)) return "VIDEO_GENERATE";
  if (attachedCount || (priorImageCount && visual.test(message))) return "VISION_ANALYZE";
  return "CHAT";
}
