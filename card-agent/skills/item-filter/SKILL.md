---
name: item-filter
description: 判定每组图片中每张图的角色（正面/反面/lot 组件/干扰图），过滤标签与文字描述等干扰信息。处理任何一组卡片图片前必须阅读并应用本技能。
whenToUse: 每次开始处理一个单卡或 lot 子夹时
---

# 图片角色判定与干扰过滤

每张图片必须归入且仅归入以下 7 类之一：

| 角色 | 含义 |
|------|------|
| `single_front` | 单张卡片的正面（有球员/角色肖像、镭射、文字排版） |
| `single_back` | 单张卡片的背面（文字密集、规则说明，通常无大图） |
| `lot_group` | lot 整组合照（一张图里多张卡叠放/排开，可能多达 25 张） |
| `lot_label` | lot 的包装袋 + 编号/标签图（编号信息主要在这一张） |
| `core_front` | lot 中核心卖点卡片的正面（通常 3~4 张核心卡） |
| `core_back` | lot 中核心卖点卡片的背面 |
| `unrelated` | 干扰图：价格标签、文字描述、包装袋特写、杂物、无关背景等 |

## 判定规则

1. 一张图只归一类；同时具备多类特征时，按「lot_group 优先于 core_front」处理。
2. 单卡模式（`singles/` 子夹）预期出现 `single_front` + `single_back`。
3. lot 模式（`lots/` 子夹）预期出现 `lot_group` + `lot_label` + `core_front` + `core_back`。
4. **干扰图（`unrelated`）的处理**：
   - 绝不从干扰图中提取任何信息（卡名、编号、价格一律不算）。
   - 干扰图要记入结果的 `skippedImages` 列表，方便人工回溯过滤是否正确。
5. 若预分类结果（prompt 中的「预分类结果」段落）已给出角色，先复核：明显错误才更正，否则沿用，避免重复判定。

## 输出

把角色判定结果写进结果 JSON 的 `imageRoles` 字段：

```json
"imageRoles": { "front.jpg": "single_front", "back.jpg": "single_back", "tag.jpg": "unrelated" },
"skippedImages": ["tag.jpg"]
```
