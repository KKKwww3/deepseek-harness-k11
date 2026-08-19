---
name: baseball-other
description: 识别棒球、橄榄球、冰球、F1 等其它运动的球星卡。当判定卡片不属于宝可梦/篮球/足球时使用，先确认具体运动再识别。
whenToUse: 判定运动类型不属于 pokemon / basketball / football 时
---

# 棒球 / 橄榄球 / 其它运动卡识别

## 第一步：先确认 sport

卡面特征判断具体运动：

| 运动 | 特征 |
|------|------|
| 棒球 | 球员棒球服、球棒、手套；Topps/Bowman 系列常见 |
| 橄榄球 | 头盔、护具；Panini 系列常见 |
| 冰球 | 冰刀、球杆、头盔 |
| F1/赛车 | 赛车、头盔、车队涂装 |

`sport` 字段取值：`baseball` / `football`（此处指美式橄榄球时注意与足球区分，可写 `american_football`）/ `hockey` / `f1` / `other`。

## 第二步：识别通用字段

1. **球员（name）**：卡面人名。
2. **系列（set）**：如 Topps Chrome、Bowman、Panini Mosaic 等。
3. **年份（year）**：系列年份。
4. **卡号（number）**：编号 + 总数（如 `88/125`）或纯序号。
5. **成色（conditionNote）**：仅明显可见时记录。

## 规则

- 先确认具体运动再套用识别，不确定时 `sport` 写 `other`。
- 读不清的字段置 `null`，绝不编造。
- 反光/模糊 → `confidence: low` + `needsReview: true`。
