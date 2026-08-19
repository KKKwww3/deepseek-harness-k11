---
name: pokemon
description: 识别宝可梦卡牌的关键信息：卡名、系列/扩展、卡号、稀有度、形态。当判定卡片为宝可梦卡时使用。
whenToUse: 判定运动类型为宝可梦（pokemon）后
---

# 宝可梦卡识别

## 关注字段

1. **卡名（name）**：卡面宝可梦名字（可能为 EX/GX/V/VMAX/VSTAR 形态，如 Charizard VMAX）。
2. **系列/扩展（set）**：如 151、Sword & Shield、Obsidian Flames。
3. **卡号（number）**：编号格式 `编号/系列总数`，如 `006/165`。
4. **稀有度（notes 可记录）**：星标、圆标、字母稀有度（C/U/R/UR/SR）等标记；不确定不写。
5. **形态（notes 可记录）**：普通 / EX / GX / V / VMAX / VSTAR / 全图等。
6. **成色（conditionNote）**：仅明显可见时记录。

## 规则

- 卡号严格保留 `006/165` 这种原格式，这是宝可梦卡最重要的标识。
- 读不清的字段置 `null`，绝不编造。
- 编号模糊时 → `confidence: low` + `needsReview: true`，不要猜一个编号。
- 卡面光泽/镭射较重，注意反光下的文字仍要尽量读取。
