# Director A/B Semantic Input Comparison
Status: READ_ONLY_COMPARISON / NOT_RENDERED / HUMAN REVIEW PENDING

Current below separates persisted frozen prompt from current code. No pixel QA/freshness recomputation/model call. Current code already forbids humans; historical jobs predate it. Empty scale/proportion/details are real evidence, not proven render causality.

## 鲸鱼 / CHAR-003

Job `da45b4df-aa9f-4d45-a2ca-2ce85e6fb942`, SUCCEEDED, ASSET_MAIN_PREVIEW, assetRevision=1, currentRevision=1; full freshness not reevaluated.

### CURRENT V0.4 INPUT — persisted frozen prompt
```text
鲸鱼
从海中央下方升起的巨大鲸鱼，一口吞没船，使光被整体吞入；后因蓝光变亮发痒而打喷嚏，将男孩与潜水艇从头顶出水口喷出。
从海中央下方升起的巨大鲸鱼，一口吞没船，使光被整体吞入；后因蓝光变亮发痒而打喷嚏，将男孩与潜水艇从头顶出水口喷出。
Identity: []. Preserve: [].
Appearance: {"silhouette":"","scale":"","proportion":"","palette":[],"materials":[],"details":{"speciesOrForm":"","bodyStructure":"","anatomy":"","relativeScale":"","surface":"","skinFurFeatherLanguage":"","eyes":"","movementLanguage":""}}.
One complete creature, readable silhouette, all wings and limbs visible, calm neutral presentation.
Cinematic stylized realism, refined concept art, soft filmic lighting, coherent material detail; no chibi proportions, no text or multi-view sheet.
Avoid: [].
Project direction (context only, do not insert other story subjects): 我想为 Dream Stream 制作一支约 40 秒的品牌短片。

Dream Stream 是一个 AI 视频创作与制片平台，我想表达的核心概念是：
“把脑海里的梦，变成真正可以制作出来的影像。”

这支片不要像普通的软件功能介绍广告，也不要只是展示界面。
我希望它有电影感、梦幻感和创作者气质，让观众感受到一个想法从脑海中出现，逐渐变成人物、场景、分镜，最后成为完整影像的过程。

目标观众主要是 AI 视频创作者、导演型创作者和有创意但缺少传统影视制作能力的人。

真实的 Dream Stream Logo 和软件 UI 后续应使用真实素材，不允许 AI 重画。
```

Current code delta: explicit unoccupied/isolation now present, but still brief excerpt plus per-asset spec; no roles/scale/lineage/beat plan.

### DIRECTOR-AUGMENTED INPUT — candidate NOT applied
```json
{
  "generationMode": "ASSET",
  "narrativeRole": {
    "canonicalKey": "CHAR-003",
    "narrativeFunction": "Overwhelming obstacle and second dream space",
    "emotionalRead": "ancient majestic overwhelming",
    "dramaticImportance": "core",
    "scaleFunction": "boy < ship << whale",
    "requiredAudiencePerception": [
      "credible ship-swallowing scale",
      "not cute"
    ],
    "forbiddenInterpretations": [
      "juvenile",
      "toy-like",
      "friendly mascot"
    ]
  },
  "globalVisualDNA": {
    "artStyle": "cinematic stylized realism / dreamlike but grounded",
    "colorLanguage": [
      "night blue",
      "preserve confirmed palettes"
    ],
    "lightingLanguage": [
      "blue emission motivates local light",
      "filmic night readability"
    ],
    "materialLanguage": [
      "one blue mist/particle/contour/solid material"
    ],
    "motionLanguage": [
      "condense → adapt → dissolve → return"
    ],
    "recurringVisualMotifs": [
      "blue matter",
      "reaching hand",
      "moon destination"
    ],
    "realismLevel": "refined film concept; not photoreal mandate",
    "atmosphere": "wonder → overwhelm → freedom → recognition",
    "forbiddenStyleDrift": [
      "mascot whale",
      "unrequested people in isolated assets",
      "inconsistent dream magic",
      "AI Logo redraw"
    ]
  },
  "scale": [
    {
      "smaller": "PROP-001",
      "larger": "CHAR-003",
      "kind": "RELATIVE",
      "shotRef": null,
      "requirement": "whale swallows whole ship"
    },
    {
      "smaller": "PROP-001",
      "larger": "CHAR-003",
      "kind": "DRAMATIC",
      "shotRef": null,
      "requirement": "ship reads toy-scale against whale, not a toy ship identity"
    }
  ],
  "lineage": [],
  "allowedSubjects": [
    "CHAR-003"
  ],
  "completeSubjectReadable": true,
  "exclude": [
    "unrequested humans/crew/riders; story actors belong in SHOT mode"
  ]
}
```

## 海盗船 / PROP-001

Job `1503fda9-9fcd-4e46-9266-5cb5442a3061`, SUCCEEDED, ASSET_MAIN_PREVIEW, assetRevision=1, currentRevision=1; full freshness not reevaluated.

### CURRENT V0.4 INPUT — persisted frozen prompt
```text
海盗船
蓝色荧光物质凝成的海盗船形态，男孩踏上后离岸驶向远处；是物质第一次完整凝聚成实体。
蓝色荧光物质凝成的海盗船形态，男孩踏上后离岸驶向远处；是物质第一次完整凝聚成实体。
Identity: []. Preserve: [].
Appearance: {"silhouette":"","scale":"","proportion":"","palette":[],"materials":[],"details":{"vehicleType":"","overallSilhouette":"","relativeScale":"","mainStructure":"","secondaryStructure":"","surfaceTreatment":"","propulsion":"","windows":"","openings":""}}.
One complete vehicle in three-quarter hero view, readable structure, materials and proportions.
Cinematic stylized realism, refined concept art, soft filmic lighting, coherent material detail; no chibi proportions, no text or multi-view sheet.
Avoid: [].
Project direction (context only, do not insert other story subjects): 我想为 Dream Stream 制作一支约 40 秒的品牌短片。

Dream Stream 是一个 AI 视频创作与制片平台，我想表达的核心概念是：
“把脑海里的梦，变成真正可以制作出来的影像。”

这支片不要像普通的软件功能介绍广告，也不要只是展示界面。
我希望它有电影感、梦幻感和创作者气质，让观众感受到一个想法从脑海中出现，逐渐变成人物、场景、分镜，最后成为完整影像的过程。

目标观众主要是 AI 视频创作者、导演型创作者和有创意但缺少传统影视制作能力的人。

真实的 Dream Stream Logo 和软件 UI 后续应使用真实素材，不允许 AI 重画。
```

Current code delta: explicit unoccupied/isolation now present, but still brief excerpt plus per-asset spec; no roles/scale/lineage/beat plan.

### DIRECTOR-AUGMENTED INPUT — candidate NOT applied
```json
{
  "generationMode": "ASSET",
  "narrativeRole": {
    "canonicalKey": "PROP-001",
    "narrativeFunction": "First traversable manifestation",
    "emotionalRead": "inviting adventure",
    "dramaticImportance": "core",
    "scaleFunction": "much smaller than whale",
    "requiredAudiencePerception": [
      "complete unoccupied ASSET structure"
    ],
    "forbiddenInterpretations": [
      "permanent crew"
    ]
  },
  "globalVisualDNA": {
    "artStyle": "cinematic stylized realism / dreamlike but grounded",
    "colorLanguage": [
      "night blue",
      "preserve confirmed palettes"
    ],
    "lightingLanguage": [
      "blue emission motivates local light",
      "filmic night readability"
    ],
    "materialLanguage": [
      "one blue mist/particle/contour/solid material"
    ],
    "motionLanguage": [
      "condense → adapt → dissolve → return"
    ],
    "recurringVisualMotifs": [
      "blue matter",
      "reaching hand",
      "moon destination"
    ],
    "realismLevel": "refined film concept; not photoreal mandate",
    "atmosphere": "wonder → overwhelm → freedom → recognition",
    "forbiddenStyleDrift": [
      "mascot whale",
      "unrequested people in isolated assets",
      "inconsistent dream magic",
      "AI Logo redraw"
    ]
  },
  "scale": [
    {
      "smaller": "CHAR-001",
      "larger": "PROP-001",
      "kind": "RELATIVE",
      "shotRef": null,
      "requirement": "ship carries boy; qualitative, not measured metres"
    },
    {
      "smaller": "PROP-001",
      "larger": "CHAR-003",
      "kind": "RELATIVE",
      "shotRef": null,
      "requirement": "whale swallows whole ship"
    },
    {
      "smaller": "PROP-001",
      "larger": "CHAR-003",
      "kind": "DRAMATIC",
      "shotRef": null,
      "requirement": "ship reads toy-scale against whale, not a toy ship identity"
    }
  ],
  "lineage": [
    {
      "from": "FX-001",
      "to": "PROP-001",
      "relationType": "MATERIAL_TRANSFORMATION",
      "inheritedVisualDNA": [
        "same blue Dream Matter"
      ],
      "preservedTraits": [
        "material identity, not anatomy"
      ],
      "transformedTraits": [
        "silhouette and function"
      ],
      "visualContinuityRules": [
        "mist → particles → contour → solid; no reset"
      ]
    },
    {
      "from": "PROP-001",
      "to": "PROP-002",
      "relationType": "MATERIAL_TRANSFORMATION",
      "inheritedVisualDNA": [
        "same blue Dream Matter"
      ],
      "preservedTraits": [
        "material identity, not anatomy"
      ],
      "transformedTraits": [
        "silhouette and function"
      ],
      "visualContinuityRules": [
        "mist → particles → contour → solid; no reset"
      ]
    }
  ],
  "allowedSubjects": [
    "PROP-001"
  ],
  "completeSubjectReadable": true,
  "exclude": [
    "unrequested humans/crew/riders; story actors belong in SHOT mode"
  ]
}
```

## 飞马 / CHAR-002

Job `6aafa442-75a6-47ce-950c-608e2382f9b2`, SUCCEEDED, ASSET_MAIN_PREVIEW, assetRevision=2, currentRevision=2; full freshness not reevaluated.

### CURRENT V0.4 INPUT — persisted frozen prompt
```text
飞马
蓝色荧光物质在男孩下坠时重新聚拢成形、驮住男孩并转向月亮向上的有翼马；回应男孩上一次伸手。
蓝色荧光物质在男孩下坠时重新聚拢成形、驮住男孩并转向月亮向上的有翼马；回应男孩上一次伸手。
Identity: []. Preserve: [].
Appearance: {"silhouette":"","scale":"","proportion":"","palette":[],"materials":[],"details":{"speciesOrForm":"","bodyStructure":"","anatomy":"","relativeScale":"","surface":"","skinFurFeatherLanguage":"","eyes":"","movementLanguage":""}}.
One complete creature, readable silhouette, all wings and limbs visible, calm neutral presentation.
Cinematic stylized realism, refined concept art, soft filmic lighting, coherent material detail; no chibi proportions, no text or multi-view sheet.
Avoid: [].
Project direction (context only, do not insert other story subjects): 我想为 Dream Stream 制作一支约 40 秒的品牌短片。

Dream Stream 是一个 AI 视频创作与制片平台，我想表达的核心概念是：
“把脑海里的梦，变成真正可以制作出来的影像。”

这支片不要像普通的软件功能介绍广告，也不要只是展示界面。
我希望它有电影感、梦幻感和创作者气质，让观众感受到一个想法从脑海中出现，逐渐变成人物、场景、分镜，最后成为完整影像的过程。

目标观众主要是 AI 视频创作者、导演型创作者和有创意但缺少传统影视制作能力的人。

真实的 Dream Stream Logo 和软件 UI 后续应使用真实素材，不允许 AI 重画。
```

Current code delta: explicit unoccupied/isolation now present, but still brief excerpt plus per-asset spec; no roles/scale/lineage/beat plan.

### DIRECTOR-AUGMENTED INPUT — candidate NOT applied
```json
{
  "generationMode": "ASSET",
  "narrativeRole": {
    "canonicalKey": "CHAR-002",
    "narrativeFunction": "Catch after dissolution; salvation",
    "emotionalRead": "freedom / transcendence",
    "dramaticImportance": "core",
    "scaleFunction": "readable boy support in SHOT",
    "requiredAudiencePerception": [
      "same blue material",
      "wings/limbs readable"
    ],
    "forbiddenInterpretations": [
      "unrelated horse",
      "rider in isolated ASSET"
    ]
  },
  "globalVisualDNA": {
    "artStyle": "cinematic stylized realism / dreamlike but grounded",
    "colorLanguage": [
      "night blue",
      "preserve confirmed palettes"
    ],
    "lightingLanguage": [
      "blue emission motivates local light",
      "filmic night readability"
    ],
    "materialLanguage": [
      "one blue mist/particle/contour/solid material"
    ],
    "motionLanguage": [
      "condense → adapt → dissolve → return"
    ],
    "recurringVisualMotifs": [
      "blue matter",
      "reaching hand",
      "moon destination"
    ],
    "realismLevel": "refined film concept; not photoreal mandate",
    "atmosphere": "wonder → overwhelm → freedom → recognition",
    "forbiddenStyleDrift": [
      "mascot whale",
      "unrequested people in isolated assets",
      "inconsistent dream magic",
      "AI Logo redraw"
    ]
  },
  "scale": [],
  "lineage": [
    {
      "from": "PROP-002",
      "to": "CHAR-002",
      "relationType": "MATERIAL_TRANSFORMATION",
      "inheritedVisualDNA": [
        "same blue Dream Matter"
      ],
      "preservedTraits": [
        "material identity, not anatomy"
      ],
      "transformedTraits": [
        "silhouette and function"
      ],
      "visualContinuityRules": [
        "mist → particles → contour → solid; no reset"
      ]
    },
    {
      "from": "CHAR-002",
      "to": "BRAND-001",
      "relationType": "COMPOSITION_RESOLUTION",
      "inheritedVisualDNA": [
        "flow guides final composition"
      ],
      "preservedTraits": [
        "confirmed real Logo geometry"
      ],
      "transformedTraits": [],
      "visualContinuityRules": [
        "NOT physical Pegasus-to-logo morph",
        "moon/flight composition then real Logo dissolve/reflection"
      ]
    }
  ],
  "allowedSubjects": [
    "CHAR-002"
  ],
  "completeSubjectReadable": true,
  "exclude": [
    "unrequested humans/crew/riders; story actors belong in SHOT mode"
  ]
}
```

Whale adds overwhelming relative scale and anti-mascot intent rather than historical calm-neutral presentation. Ship separates reusable unoccupied structure from boy-boarded story. Pegasus adds salvation/freedom and material continuity. Better render is a testable hypothesis, not guaranteed by these semantic inputs.
