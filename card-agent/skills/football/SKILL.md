---
name: football
description: 识别足球球星卡的关键信息：球员、球队、联赛、系列、年份、卡号、成色。当判定卡片为足球卡时使用。
whenToUse: 判定运动类型为足球后
---

# 足球球星卡识别

## 关注字段

1. **球员（name）**：卡面人名，通常配合球衣照。格式「名字 姓」。
2. **球队/联赛（notes 可记录）**：如 Real Madrid / La Liga、Manchester City / Premier League。
3. **系列（set）**：如 Topps Merlin、Panini Prizm 世界杯版等。
4. **年份（year）**：系列年份。
5. **卡号（number）**：编号 + 总数（如 `25/99`）或纯序号。
6. **成色（conditionNote）**：仅明显可见时记录。

## 规则

- 足球卡版式差异大（国家队/俱乐部、各联赛），优先认卡名与编号。
- 卡号只取可见编号，保持原样。
- 读不清的字段置 `null`，绝不编造。
- 反光/模糊导致不可读 → `confidence: low` + `needsReview: true`。
