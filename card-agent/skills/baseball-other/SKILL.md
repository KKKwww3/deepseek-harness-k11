---
name: baseball-other
description: 棒球/橄榄球等其他运动球星卡的识别规则，包括球员名、年份、系列、卡号、球队等信息的提取要点。
whenToUse: 判定图片属于棒球卡、橄榄球卡或其他未单独列出的运动卡时使用。
---

# 棒球 / 橄榄球等其他运动卡识别

该技能覆盖棒球（MLB）、橄榄球（NFL）以及未被单独列出的运动类卡。

## 正面卡面布局

- **球员名（Player name）**：正面显著位置。
- **球队**：球员名附近或球衣上的球队名/队标。
- **年份与系列**：例如 `2021 Topps Series 1`、`2022 Panini Prizm Football`。
- **卡号（Card number）**：卡片底部，格式如 `25/99`、`#120`。
- **位置**：如棒球的 P/C/IF/OF，橄榄球的 QB/RB/WR 等。
- **新秀标记**：如 RC（Rookie Card），记录进 notes。

## 识别优先级

1. 球员名 + 年份 + 系列。
2. 卡号。
3. 球队/位置/新秀标记作为补充。

## 如何判断具体运动

- 棒球：卡面上有棒球、球棒、球场元素，或 Topps/Donruss/Bowman 等棒球系列名。
- 橄榄球：卡面上有橄榄球、头盔、球场线标元素，或 Panini Prizm Football 等系列名。
- 若无法确定具体运动，sport 字段记为最接近的分类并在 notes 中说明。

## 输出示例

- name: "Shohei Ohtani", set: "Topps Series 1", year: 2021, number: "100/330"
- name: "Patrick Mahomes", set: "Prizm Football", year: 2022, number: "18/249"
