---
name: output-format
description: 定义结果 JSON 的统一字段与写入规范。每次写识别结果时必须遵循本格式。
whenToUse: 每次把识别结果写入文件时使用。
---

# 结果输出规范

## 单卡记录

```json
{
  "customerId": "A",
  "itemId": "A-001",
  "itemType": "single-card",
  "sport": "basketball",
  "cards": [
    {
      "name": "LeBron James",
      "set": "Prizm",
      "year": 2020,
      "number": "220/300",
      "isCore": true,
      "rarity": "Silver",
      "conditionNote": ""
    }
  ],
  "imageRoles": { "front.jpg": "front", "back.jpg": "back", "tag.jpg": "unrelated" },
  "skippedImages": ["tag.jpg"],
  "confidence": "high",
  "needsReview": false,
  "notes": ""
}
```

## lot 记录

```json
{
  "customerId": "A",
  "itemId": "A-002",
  "itemType": "lot",
  "sport": "pokemon",
  "lotId": "LOT-202",
  "cardCount": 10,
  "coreCards": [
    {
      "name": "Charizard",
      "set": "151",
      "year": 2023,
      "number": "006/165",
      "isCore": true,
      "rarity": "Rare",
      "conditionNote": ""
    }
  ],
  "imageRoles": {
    "group.jpg": "group",
    "label.jpg": "label",
    "core_front.jpg": "core_front",
    "core_back.jpg": "core_back"
  },
  "skippedImages": [],
  "confidence": "medium",
  "needsReview": false,
  "notes": ""
}
```

## 写入规则

1. 结果写入任务指定的输出路径（默认是单条 JSON 文件；批量脚本会合并成
   `result.jsonl`）。
2. 每条必须是合法 JSON 对象，字段不可省略；读不到的字段写 `null`。
3. `sport` 取值固定为：`pokemon` / `basketball` / `football` / `baseball` / `other`。
4. `confidence` 取 `high` / `medium` / `low`；低于 `high` 时 `needsReview` 置 `true`。
5. 运动类型、卡名、编号等不确定时，**宁缺毋滥**：置 `null` + 进 review，
   绝不编造。
6. `imageRoles` 记录每组所有图的角色判定（含 unrelated），用于回溯过滤是否正确。
7. 单卡记录用 `cards`，lot 记录用 `coreCards`，不要混用。
