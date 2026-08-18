---
name: football
description: 足球球星卡识别：球员名、联赛/球队、系列（Topps/Panini 等）、年份、卡号、限量信息。
whenToUse: 图片被判定为足球球星卡时使用。
---

# 足球卡识别

## 看正面（front / core_front）

- **球员名**：卡面大标题（如 Lionel Messi、Kylian Mbappe、Erling Haaland）。
- **球队 / 联赛**：卡面上的队徽或联赛标识（如 FC Barcelona、Real Madrid、
  国家队），原样记录球队名；可辅助确认运动归属。
- **系列 / 品牌**：Topps、Panini、Upper Deck 等 + 系列名（如 Topps Chrome UCL、
  Panini Prizm World Cup），原样记录。
- **年份**：系列年份（如 `2023-24` → `2023`）；无法判断写 `null`。
- **卡号**：底部编号，格式如 `150/199`；未编号写 `no-number`。
- **限量 / 平行**：能识别则记录，识别不清置 `null`，不要编造。

## 看背面（back / core_back）

- 品牌 Logo、条款、卡片描述文字，辅助确认系列 / 年份 / 真伪。
- 不要从背面编造球员数据。

## 输出字段

`name`、`team`、`set`、`year`、`number`、`parallel`。
