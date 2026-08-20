---
name: refractor-match
description: 用向量语义匹配把折射外观(描述+图案+颜色)映射成行业标准名词，并定义置信度、兜底与 review 规则。得到 refractor-vlm 的结构化输出、写结果前必读。
whenToUse: 拿到一张卡的折射识别结果，需要滑动到标准专业名词并写结果时使用。
---

# 折射名词向量匹配与输出

## 匹配流程

1. 把 refractor-vlm 的结构化识别 JSON（pattern / color / brand / year / series / desc）
   交给 `scripts/match.py`（参数见下），程序会：embedding → 缩到品牌×系列桶 → 相似度匹配 → 返回标准名词。
2. 匹配分 ≥ 阈值（默认 0.70，可 `--threshold` 覆盖；已按当前 embedding 模型校准）→ 直接采纳。
3. 匹配分 < 阈值 或 未命中 → 把桶外扩到全量再匹配一次；仍低于阈值 → `needsReview: true`。
4. `pattern=平卡` → `refraction: null`，不算失败，不走匹配。

## 调用

```bash
python scripts/match.py \
  --rec '{"brand":"panini","year":"2022","series":"prizm","pattern":"碎冰","color":"红","desc":"红色水晶裂纹折射"}' \
  --db db/refractors.lance --threshold 0.85
```

返回：
```json
{ "matched": true, "refraction": "碎冰红", "name_en": "Red Ice",
  "pattern": "碎冰", "color": "红", "matchScore": 0.87 }
```

## 输出规范（写结果 JSONL，每股一行）

```json
{
  "itemId": "A-001",
  "brand": "panini",
  "series": "prizm",
  "year": "2022",
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

1. 折射名词**必须来自匹配结果**，绝不自己编造。
2. `needsReview: true` 时，把该条也追加到 `review.jsonl`（路径与原因）。
3. 无法判定是否折射（图片太糊/反光看不清）→ `needsReview: true`，不硬给 `refraction`。
4. `refraction: null`（平卡）不是错误，不要进 review。