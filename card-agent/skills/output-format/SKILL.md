---
name: output-format
description: 结果 JSON 的字段与格式规范。写入任何识别结果前必须阅读，保证输出结构统一。
whenToUse: 每次写入一条识别结果 JSON 时
---

# 结果 JSON 规范

输出文件路径由任务指令中的「结果输出文件」给出。**每项只写一条 JSON 记录**。

## 单卡记录（itemType = single-card）

```json
{
  "customerId": "A",
  "itemId": "A-001",
  "itemType": "single-card",
  "sport": "basketball",
  "cards": [
    { "name": "LeBron James", "set": "Prizm", "year": 2020,
      "number": "220/300", "isCore": true, "conditionNote": "" }
  ],
  "imageRoles": { "front.jpg": "single_front", "back.jpg": "single_back" },
  "skippedImages": ["tag.jpg"],
  "confidence": "high",
  "needsReview": false,
  "notes": ""
}
```

## lot 记录（itemType = lot）

```json
{
  "customerId": "A",
  "itemId": "A-LOT202",
  "itemType": "lot",
  "sport": "pokemon",
  "lotId": "LOT-202",
  "cardCount": 25,
  "coreCards": [
    { "name": "Charizard VMAX", "set": "151", "year": 2023,
      "number": "006/165", "isCore": true, "conditionNote": "" }
  ],
  "imageRoles": { "group.jpg": "lot_group", "label.jpg": "lot_label",
                  "core_front.jpg": "core_front", "core_back.jpg": "core_back" },
  "skippedImages": [],
  "confidence": "medium",
  "needsReview": true,
  "notes": "编号模糊，请复核"
}
```

## 字段规则

- `itemId`：`customerId` 与子夹名组合（如 `A-001`），**不要自行发明**。
- `sport` 取值：`pokemon` / `basketball` / `football` / `baseball` / `american_football` / `hockey` / `f1` / `other`。
- `confidence`：`high` / `medium` / `low`。
- 读不清的字段一律 `null` 或空字符串，**绝不编造**。
- 低置信度 → `needsReview: true`；干扰图记入 `skippedImages` 且绝不在 `cards` 里体现。
- lot 只列核心卖点卡到 `coreCards`，不逐一列合照里的全部卡。
- 不确定的项：先尽力识别，标记 `needsReview: true`，不要因一张卡中断整批。
