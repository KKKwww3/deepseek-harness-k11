---
name: item-filter
description: 判定一组卡片图片中每张图的角色（front/back/core_front/core_back/group/label），并过滤标签图、文字描述图等干扰信息。处理任何一组卡片之前必读。
whenToUse: 开始识别任何一组卡片图片之前，需要先确定每张图片的角色并排除干扰图时。
---

# 图片角色判定与干扰过滤

## 角色定义

对一组图片中的每一张图，判定且仅判定一个角色：

| 角色 | 含义 |
|---|---|
| `front` | 单张卡片的正面（含卡名、系列、编号、球员/宝可梦形象） |
| `back` | 单张卡片的背面（品牌 Logo / 版权 / 规则文字，用于确认真伪与系列） |
| `core_front` | lot 中核心卖点卡的正面 |
| `core_back` | lot 中核心卖点卡的背面 |
| `group` | lot 整组卡片的合照（一张图含多张卡，用于确认总卡数） |
| `label` | lot 的标号 + 透明包装袋图（lot 编号信息所在） |
| `unrelated` | 干扰图，不识别、跳过 |

## 判定规则

1. 每张图独立判定，**以画面内容为准，不要用文件名猜角色**。
2. 明显不是卡片内容的图一律判 `unrelated`：价格标签、手写纸条、
   电脑/手机屏幕文字、外包装盒、展示柜、无关物品、纯文字描述图。
3. 单卡组（`singles/<id>/`）通常应恰好有一张 `front` 和一张 `back`；
   多出来的图判 `unrelated`。
4. lot 组（`lots/<id>/`）通常应有 `group`、`label`、`core_front`、
   `core_back`；核心卖点卡可能多张（多张核心正/反），逐一识别。
5. 同一张图里出现多张卡 → 判 `group`（合照），不是单卡正面。
6. 对无法确认角色的图，判 `unrelated` 并记入 review，不要硬猜成卡片图。

## 输出

把每张图的角色记录到结果 JSON 的 `imageRoles` 字段（path → role），
`unrelated` 的图记入 `skippedImages`，**不从任何 unrelated 图中提取卡片信息**。
