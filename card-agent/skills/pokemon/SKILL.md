---
name: pokemon
description: 宝可梦 TCG 卡识别：卡名、系列、卡号（如 025/165）、稀有度标记、形态差异（Holo/Full Art/EX/GX/V 等）。
whenToUse: 图片被判定为宝可梦（Pokemon TCG）卡时使用。
---

# 宝可梦卡识别

## 看正面（front / core_front）

- **卡名**：卡面英文大标题（如 Charizard、Pikachu）；日文/中文版按图中文字原样识别。
- **系列**：卡面小字，常位于右下角或卡面边缘（如 `151`、`Scarlet & Violet`、
  `Crown Zenith`、`Paldean Fates`）。
- **卡号**：右上角编号，格式通常为 `NNN/总卡数`（如 `025/165`）。
  部分 promo / 特殊卡无编号，写 `no-number`。
- **稀有度**：右下角符号 —— 圆圈=Common、菱形=Uncommon、星形=Rare、
  双星 / 特殊符号=更高稀有。
- **形态 / 版本**：卡面闪层=Holofoil；全幅插画=Full Art；以及卡名旁的
  EX / GX / V / VMAX / VSTAR / ex 等标识，原样记录。
- **属性**：左上角能量属性标记（Fire / Water / Lightning / Psychic 等）。

## 看背面（back / core_back）

- 标准宝可梦背纹（精灵球图案），用于确认真伪与归属。
- 背面**不提供**系列 / 编号信息，不要从背面提取这些字段。

## 输出字段

`name`、`set`、`year`（可推断时）、`number`、`rarity`、`variant`（Holo/Full Art/EX 等）。
