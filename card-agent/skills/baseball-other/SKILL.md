---
name: baseball-other
description: 棒球及其他运动（橄榄球、冰球、F1 等）球星卡识别：先确认运动/联赛，再提取球员名、系列、年份、卡号。
whenToUse: 图片被判定为棒球、橄榄球、冰球、F1 等其他运动卡时使用。
---

# 棒球及其他运动卡识别

## 通用规则

1. **先确认运动 / 联赛**：Baseball（MLB）、American Football（NFL）、
   Hockey（NHL）、F1、Soccer（已归 football 技能）等，写入 `sport` 字段。
2. **球员名**：卡面大标题，原样识别（如 Shohei Ohtani、Patrick Mahomes、
   Connor McDavid、Max Verstappen）。
3. **系列 / 品牌**：Panini、Topps、Upper Deck 等 + 系列名，原样记录。
4. **年份**：系列年份（如 `2023-24` → `2023`）；无法判断写 `null`。
5. **卡号**：底部编号，格式如 `88/250`；未编号写 `no-number`。
6. **队徽 / 联盟 Logo** 辅助确认运动归属与球队。

## 看背面（back / core_back）

- 品牌 Logo、条款、描述文字，辅助确认系列 / 年份 / 真伪。
- 不要从背面编造球员数据。

## 输出字段

`sport`、`name`、`team`、`set`、`year`、`number`。
