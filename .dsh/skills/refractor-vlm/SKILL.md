---
name: refractor-vlm
description: 说明 VLM 识别脚本（scripts/vlm.py）的输出协议与校验规则：结构化 pattern/color/brand/series/desc、受控枚举、同图案不同颜色独立、反面版权文字优先。任何一张卡的前/反面图识别之后、匹配之前必读。
whenToUse: 拿到卡图需要获取结构化折射识别结果时，以及校验 vlm.py 输出是否符合协议时。
---

# 折射外观 VLM 识别协议与校验

识别由 `scripts/vlm.py` 完成（火山方舟视觉模型，受控枚举提示词）——**不要自己看图编造识别结果**。本技能说明它的输出协议，以及拿到输出后如何校验。

## 调用

```bash
cd refractor-agent && python scripts/vlm.py <正面图> <反面图>
```

图片输入支持：本地路径 / http(s) URL / data URI / 裸 base64（可混用）。

输出（一段严格 JSON，无其他文字）：

```json
{
  "pattern": "碎冰",          // 图案类型（受控枚举，见下方）
  "color": "红",              // 颜色（受控枚举；无法确定写 "无"）
  "brand": "panini",          // 品牌，小写
  "series": "prizm",          // 系列，小写
  "desc": "红色水晶裂纹状折射，光线下反光"  // 自由外观描述（作向量输入）
}
```

不需要年份：折射规格跨年份一致，命名不随年份变化。

## 受控枚举（必须与词典 schema 对齐）

> 唯一维护文件是 `dicts/refractions.yml`：pattern/color 合法集自动从「已登记的
> 折射」推导（无需单独枚举文件），VLM 提示词由 `scripts/vlm.py` 运行时生成。
> **校验前用 read 工具读取 `dicts/refractions.yml`，以读到的最新值为准**——不要凭记忆。

- **pattern（图案）**：当前合法集合 = `dicts/refractions.yml` 里已登记折射的 pattern（外加 `平卡` / `其他`）。操作前 read `dicts/refractions.yml`。
  - 只在该系列词典出现的新图案，先记 `其他` + 进 review，不编造新词。
- **color（颜色）**：当前合法集合 = 已登记折射的 color（外加 `无` / `其他`）。
- **brand / series**：VLM 纯文本识别稳定返回（小写，如 `panini`/`prizm`），脚本会自动小写 + 去空白归一化；无法判定时记 `unknown`，匹配时无法命名 → 进 review。

## 校验规则（拿到 vlm.py 输出后逐条核对）

1. **反面优先**：品牌 Logo、系列名以反面文字为准；正面系列名做交叉印证。输出不符则重跑或进 review。
2. **颜色从折光判断**：折射颜色看整体折光色调，不要被卡面图案底色干扰。
3. **同图案不同颜色 = 不同折射**：碎冰 + 银 / 碎冰 + 红 / 碎冰 + 蓝 各自独立，
   `pattern` 相同只是 `color` 不同，**绝不能合并成一个**。
4. 读不清的字段写 `null` 或 `unknown`，`pattern=平卡` 表示无折射（不算失败）。
5. 只取这一段 JSON，不要夹带解释文字。

## 输出流转

把这段 JSON 传给 refractor-match 的匹配步骤（作为 `scripts/match.py` 的输入；
脚本在仓库 `refractor-agent/` 目录下，调用前先 `cd` 到该目录）。
