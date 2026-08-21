---
name: refractor-match
description: 用向量语义匹配把折射外观(描述+图案+颜色)映射成全局折射类型，再按品牌×系列查命名表得到行业标准名词，并定义置信度、兜底与 review 规则。得到 refractor-vlm 的结构化输出、写结果前必读。
whenToUse: 拿到一张卡的折射识别结果，需要滑动到标准专业名词并写结果时使用。
---

# 折射名词向量匹配与输出

## 匹配流程

1. 把 refractor-vlm 的结构化识别 JSON（pattern / color / brand / series / desc）
   交给 `scripts/match.py`：程序会 embedding → **全局类型匹配**（向量库存的是
   共享的折射类型，每类型一条）→ **从数据库 `refraction_names` 按 brand×series×pattern×color 查询** → 返回该系列的标准名词。
2. 匹配分 ≥ 阈值（默认 0.70，可 `--threshold` 覆盖；已按当前 embedding 模型校准）→ 直接采纳。
3. 匹配分 < 阈值 → `needsReview: true`。
4. 类型命中但该系列命名表里没有（品牌/系列 unknown，或该系列不卖这种折）→ `needsReview: true`。
5. `pattern=平卡` → `refraction: null`，不算失败，不走匹配。

## 调用

```bash
python scripts/match.py \
  --rec '{"brand":"panini","series":"prizm","pattern":"碎冰","color":"红","desc":"红色水晶裂纹折射"}'
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

## 纪律

1. 折射名词**必须来自匹配结果的系列命名**，绝不自己编造。
2. `needsReview: true` 时，把该条也追加到 `review.jsonl`（路径与原因）。
3. 无法判定是否折射（图片太糊/反光看不清）→ `needsReview: true`，不硬给 `refraction`。
4. `refraction: null`（平卡）不是错误，不要进 review。
