---
name: refractor-match
description: 用向量语义匹配把折射外观(描述+图案+颜色)映射成全局折射类型，再按品牌×系列查命名表得到行业标准名词，并定义置信度、兜底与 review 规则。得到 refractor-vlm 的结构化输出、写结果前必读。
whenToUse: 拿到一张卡的折射识别结果，需要归到标准专业名词并写结果时使用。
---

# 折射名词向量匹配与输出

## 匹配流程

1. 把 refractor-vlm 的结构化识别 JSON（pattern / color / brand / series / desc）
   交给 `refractor_match` 工具：工具内部完成 embedding → **全局类型匹配**（向量库存的是共享的折射类型，每类型一条）→ **从数据库 `refraction_names` 按 brand×series×pattern×color 查询** → 返回该系列的标准名词。
2. 匹配分 ≥ 阈值（部署级配置，已按当前 embedding 模型校准；工具可传 `threshold` 覆盖）→ 直接采纳。
3. 匹配分 < 阈值 → 工具返回 `needsReview: true`。
4. 类型命中但该系列命名表里没有（品牌/系列 unknown，或该系列不卖这种折）→ `needsReview: true`。
5. `pattern=平卡` → 工具直接返回 `refraction: null`，不算失败，不走匹配。

## 调用

```text
调用 refractor_match 工具（preset 自带，无需定位脚本）：
  pattern / color / brand / series / desc = refractor_recognize 的输出字段
  threshold（可选）= 覆盖部署阈值
```

返回（同一类型在不同系列叫法不同，命名以 rec 的 brand/series 为准）：
```json
{ "matched": true, "refraction": "碎冰红", "name_en": "Red Ice",
  "pattern": "碎冰", "color": "红", "matchScore": 0.87, "needsReview": false }
```

## 输出规范（写结果 JSONL，每股一行）

```json
{
  "itemId": "A-001",
  "brand": "panini",
  "series": "prizm",
  "refraction": "碎冰红",
  "name_en": "Red Ice",
  "pattern": "碎冰",
  "color": "红",
  "desc": "红色水晶裂纹折射",
  "matchScore": 0.87,
  "needsReview": false
}
```

批量任务不需要手写结果：`refractor_batch_run` 工具内部完成识别、匹配与
result.jsonl / review.jsonl 落盘，你只汇报汇总。

## 纪律

1. 折射名词**必须来自匹配工具的返回**，绝不自己编造。
2. `needsReview: true` 时，单项任务把该条也追加到 `review.jsonl`（路径与原因）；批量任务工具已自动落盘。
3. 无法判定是否折射（图片太糊/反光看不清）→ `needsReview: true`，不硬给 `refraction`。
4. `refraction: null`（平卡）不是错误，不要进 review。
