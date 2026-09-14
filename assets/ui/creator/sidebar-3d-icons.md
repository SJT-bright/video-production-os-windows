# 大厅导航 3D 图标 · 2026-09-12

## 设计与用途

使用内置 imagegen 生成四张新的 PNG，未使用 CLI。按 apple-design 的一致性原则统一珍珠陶瓷、彩色珐琅与柔和立体光照；不同功能用不同轮廓区分，不只是换色。

图片创作和视频创作直接沿用已确认的模式切换图标。修正两个虚拟创作入口未注册到应用表时使用同一个默认图标的问题。保留精简后的导航，不恢复剧本拆解和镜头台账。

| 大厅入口 | 图形 | 资产文件 |
| --- | --- | --- |
| 图片创作 | 蓝色山峰与太阳 | image-3d-v1.png |
| 视频创作 | 红色播放键 | video-3d-v1.png |
| 创作资产 | 蓝色素材文件夹 | library-3d-v1.png |
| 总览 | 四色仪表盘模块 | overview-3d-v1.png |
| 媒体索引 | 媒体卡片与放大镜 | media-index-3d-v1.png |
| 音频素材 | 绿色音符 | audio-3d-v1.png |
| Obsidian 资产 | 紫色水晶 | obsidian-3d-v1.png |
| 成片库 | 场记板 | film-3d-v1.png |
| 项目知识 | 打开的书 | knowledge-3d-v1.png |
| Agent 与规则 | 紫色星芒 | sparkle-3d-v1.png |
| 使用说明 | 橙白救生圈 | help-3d-v1.png |

应用品牌保留 studio-3d-v1.png 的蓝色窗口图标。用户素材、第三方网站内容与展开等操作箭头均不改变。

## 生成提示词

参考文件：`video-3d-v1.png`，仅用于材质、光照和视角；不是编辑目标。

首轮输出带有误绘的棋盘背景，没有直接用于界面。救生圈经同一内置工具移除背景后保留真实 alpha；其余三张采用同一工具生成的干净白底版本，以圆角白色图标底座呈现，不将白底文件宣称为透明 PNG。未用代码重绘或抠图。

### 最终白底版本：总览、媒体索引、Obsidian

```text
Use case: precise-object-edit. The input is the EDIT TARGET. Replace the gray and white checkerboard background completely with one flat solid pure WHITE #FFFFFF background. This time a fully OPAQUE white background is required; do NOT output transparency or any checkerboard. Every background pixel must be clean white with no texture, no gray checkers, no speckles or pattern. Keep the exact 3D object design, colors, silhouette and perspective. Reduce its scale slightly so it occupies 78% of the square canvas centered with equal white margins. The image will be displayed inside a small rounded white macOS app-icon badge. Preserve the sculpted pearl and glossy enamel depth. No new symbols, no words, no extra objects.
```

### 救生圈背景修正

```text
Use case: background-extraction. Input image 1 is the EDIT TARGET. Remove the entire gray and white checkerboard pattern outside the 3D icon. Those checks are an unwanted painted background, not part of the icon. Replace the background with REAL TRANSPARENCY (alpha zero). Also remove checks seen inside any hole in the icon. Keep the 3D object exactly unchanged: silhouette, position, scale, pearl material, color, lighting and perspective. Return an isolated icon PNG suitable for arbitrary colored UI surfaces. No checkerboard grid, no texture, no background decoration, no speckles, no fake transparency preview. Transparent pixels must have no drawn contents. Do not repaint or add any new element to the object.
```

### overview

输出：`overview-3d-v1.png`

```text
Use case: stylized-concept. Generate ONE new isolated premium 3D navigation icon for a macOS video creation application. Use the attached red play icon ONLY as a material, lighting and camera style reference, NOT as a symbol to reproduce. The new subject is described below. Same pearl-white ceramic and colored translucent enamel, rounded extruded thickness, soft upper-left studio highlights, silver rim details and restrained ambient occlusion. Almost frontal, slight elevated three-quarter view. Bold simple silhouette readable at 22–80 px; avoid tiny details. Centered square canvas, object fills 82%, equal padding. TRUE TRANSPARENT alpha background, no colored background, no floor plane, no text, no labels, no branding, no humans, no scene, no scattered particles or speckles. Clean antialiased silhouette. Not flat vector, not emoji, no red play triangle. The deliverable is the icon only.
Subject: A pearl-white softly rounded square dashboard panel bearing exactly four large raised glossy rounded-square modules in a clean 2 by 2 grid. The four modules are sapphire blue, aqua, warm amber and soft violet. Wide clean grooves between them. A unified sculpted overview dashboard icon. No browser title bar, no tabs, no charts, no small marks.
```

### media-index

输出：`media-index-3d-v1.png`

```text
Use case: stylized-concept. Generate ONE new isolated premium 3D navigation icon for a macOS video creation application. Use the attached red play icon ONLY as a material, lighting and camera style reference, NOT as a symbol to reproduce. The new subject is described below. Same pearl-white ceramic and colored translucent enamel, rounded extruded thickness, soft upper-left studio highlights, silver rim details and restrained ambient occlusion. Almost frontal, slight elevated three-quarter view. Bold simple silhouette readable at 22–80 px; avoid tiny details. Centered square canvas, object fills 82%, equal padding. TRUE TRANSPARENT alpha background, no colored background, no floor plane, no text, no labels, no branding, no humans, no scene, no scattered particles or speckles. Clean antialiased silhouette. Not flat vector, not emoji, no red play triangle. The deliverable is the icon only.
Subject: A compact stack of two overlapping thick pearl-white rectangular media index cards, with a single large magnifying glass crossing the front at lower right. The front card has one broad cyan raised thumbnail block, without landscape or play symbols. The magnifier has a polished blue-turquoise rim, subtle translucent light aqua lens and a short chunky silver handle. Simple immediately recognizable media search/index silhouette. No folder, no writing, no extra loose objects.
```

### obsidian

输出：`obsidian-3d-v1.png`

```text
Use case: stylized-concept. Generate ONE new isolated premium 3D navigation icon for a macOS video creation application. Use the attached red play icon ONLY as a material, lighting and camera style reference, NOT as a symbol to reproduce. The new subject is described below. Same pearl-white ceramic and colored translucent enamel, rounded extruded thickness, soft upper-left studio highlights, silver rim details and restrained ambient occlusion. Almost frontal, slight elevated three-quarter view. Bold simple silhouette readable at 22–80 px; avoid tiny details. Centered square canvas, object fills 82%, equal padding. TRUE TRANSPARENT alpha background, no colored background, no floor plane, no text, no labels, no branding, no humans, no scene, no scattered particles or speckles. Clean antialiased silhouette. Not flat vector, not emoji, no red play triangle. The deliverable is the icon only.
Subject: One upright polished faceted amethyst crystal, a broad asymmetric hexagonal gem with a tapered top, thick beveled surfaces and rich violet-to-indigo depth. Subtle lavender translucent facets and restrained white specular highlights, gently rounded facet junctions consistent with sculpted premium app artwork. Crystal itself is the icon, no tile behind it, no base, no book, no star, no sparkle rays, no small floating crystals.
```

### help

输出：`help-3d-v1.png`

```text
Use case: stylized-concept. Generate ONE new isolated premium 3D navigation icon for a macOS video creation application. Use the attached red play icon ONLY as a material, lighting and camera style reference, NOT as a symbol to reproduce. The new subject is described below. Same pearl-white ceramic and colored translucent enamel, rounded extruded thickness, soft upper-left studio highlights, silver rim details and restrained ambient occlusion. Almost frontal, slight elevated three-quarter view. Bold simple silhouette readable at 22–80 px; avoid tiny details. Centered square canvas, object fills 82%, equal padding. TRUE TRANSPARENT alpha background, no colored background, no floor plane, no text, no labels, no branding, no humans, no scene, no scattered particles or speckles. Clean antialiased silhouette. Not flat vector, not emoji, no red play triangle. The deliverable is the icon only.
Subject: One sculpted circular rescue life ring viewed almost straight on, made from thick pearl-white ceramic with four evenly spaced glossy warm-orange enamel sections. A large clean circular hole in the center makes a distinctive silhouette; softly rounded inflated profile, restrained silver inner edge. Simple premium macOS help icon. No rope, no text, no question mark, no background tile, no book.
```
