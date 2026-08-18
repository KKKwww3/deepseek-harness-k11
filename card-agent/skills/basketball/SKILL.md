---
name: basketball
description: 篮球球星卡识别：球员名、系列（Prizm/Select/Topps 等）、年份、卡号、平行/限量信息。
whenToUse: 图片被判定为篮球球星卡时使用。
---

# 篮球卡识别

## 看正面（front / core_front）

- **球员名**：卡面大标题（英文，如 LeBron James、Luka Doncic、Jalen Green）。
- **系列 / 品牌**：卡面或底部品牌行（Panini Prizm、Panini Select、Topps Chrome、
  Hoops、Donruss 等），原样记录。
- **年份**：系列年份，如 `2023-24` → 记录 `2023`；无法判断写 `null`。
- **卡号**：底部编号，格式如 `220/300`（第 220 张 / 限量 300）。
  未编号写 `no-number`。
- **平行 / 限量**：卡面颜色与文字差异（Prizm 的 Silver / Red Ice / Green 等），
  以及 `#/XXX` 限量标号，能识别则记录；识别不清置 `null`，不要编造平行名。

## 看背面（back / core_back）

- 多为品牌 Logo、条款、卡片描述文字，用于辅助确认系列 / 年份 / 真伪。
- **不要**从背面编造球员数据（球队、数据统计等）。

## 输出字段

`name`、`set`、`year`、`number`、`parallel`。
