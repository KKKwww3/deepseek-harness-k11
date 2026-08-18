---
name: football
description: 足球球星卡（Soccer）的识别规则，包括球员名、年份、系列、卡号、俱乐部/国家队等信息的提取要点。
whenToUse: 判定图片属于足球球星卡、需要提取足球卡信息时使用。
---

# 足球球星卡识别

足球卡以 Panini、Topps、Donruss 等为主，按以下要点提取。

## 正面卡面布局

- **球员名（Player name）**：正面显著位置，通常横排。
- **俱乐部/国家队**：球员名下方或球衣上的队名/队徽；国家队卡会带国旗或国家名。
- **年份与系列**：例如 `2022 Panini Prizm World Cup`、`2020-21 Topps Merlin`。
- **卡号（Card number）**：卡片底部，格式如 `18/100`、`#23`。
- **位置**：GK/DF/MF/FW 或具体位置。
- **新秀/重大里程碑**：若有标注（如 RC、纪念某赛事），记录进 `notes`。

## 识别优先级

1. 球员名 + 年份 + 系列。
2. 卡号。
3. 俱乐部/国家队与位置作为补充。

## 常见陷阱

- 世界杯/欧洲杯等赛事卡，年份和赛事名都要保留（如 `2022 World Cup`）。
- 编号限量 `XX/XXX` 保留完整格式。
- 同一球员不同俱乐部时期卡的队名可能不同，以卡面实际标注为准。

## 输出示例

- name: "Lionel Messi", set: "Prizm World Cup", year: 2022, number: "18/100"
- name: "Erling Haaland", set: "Topps Merlin", year: "2020-21", number: "53/250"
