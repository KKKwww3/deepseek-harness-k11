---
name: refractor-vlm
description: 识别球星卡折射外观，强制输出图案(pattern)+颜色(color)结构化属性，并自判定品牌(brand)/系列(series)。处理任何一张卡的前/反面图之前必读。
whenToUse: 需要把一张卡片的折射外观转成结构化识别结果时。
---

# 折射外观 VLM 识别

对一张卡的**正面 + 反面**图做识别，输出一段**结构化 JSON**。关键纪律：
图案与颜色不能靠印象猜，品牌/系列要从反面版权文字确认。

## 输出结构

```json
{
  "pattern": "碎冰",          // 图案类型（必须是受控枚举，见下方）
  "color": "红",              // 颜色（受控枚举；无法确定写 "无"）
  "brand": "panini",          // 品牌，多从反面版权/Logo 判定
  "series": "prizm",          // 系列，多从正面/反面系列名判定
  "desc": "红色水晶裂纹状折射，光线下反光"  // 自由外观描述（作向量输入）
}
```

不需要输出年份：折射规格跨年份一致，命名不随年份变化。

## 受控枚举（必须与词典 schema 对齐）

> 唯一维护文件是 `dicts/refractions.yml`：pattern/color 合法集自动从「已登记的
> 折射」推导（无需单独枚举文件），VLM 提示词由 `scripts/vlm.py` 运行时生成。
> **操作前用 read 工具读取 `dicts/refractions.yml`，以读到的最新值为准**——不要凭记忆。

- **pattern（图案）**：当前合法集合 = `dicts/refractions.yml` 里已登记折射的 pattern（外加 `平卡` / `其他`）。操作前 read `dicts/refractions.yml`。
  - 只在该系列词典出现的新图案，先记 `其他` + 进 review，不编造新词。
- **color（颜色）**：当前合法集合 = 已登记折射的 color（外加 `无` / `其他`）。
- **brand / series**：以 `dicts/refractions.yml` 的 `aliases` 段为准；不在别名表内记 `unknown`，匹配时无法命名 → 进 review。

## 判定规则

1. **反面优先**：品牌 Logo、系列名以反面文字为准；正面系列名做交叉印证。
2. **颜色从折光判断**：折射颜色看整体折光色调，不要被卡面图案底色干扰。
3. **同图案不同颜色 = 不同折射**：碎冰 + 银 / 碎冰 + 红 / 碎冰 + 蓝 各自独立，
   `pattern` 相同只是 `color` 不同，**绝不能合并成一个**。
4. 读不清的字段写 `null` 或 `unknown`，`pattern=平卡` 表示无折射（不算失败）。
5. 只输出这一段 JSON，不要夹带解释文字。

## 输出写入

把这段 JSON 传给 refractor-match 的匹配步骤（作为 `scripts/match.py` 的输入）。
