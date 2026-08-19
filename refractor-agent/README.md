# refractor-agent — 球星卡折射专业名词规范化 Agent

基于 DeepSeek Harness (dsh) 的独立 Agent，专门解决球星卡**折射（parallel / refractor）行业专业名词**识别不准的问题。
把卡面上模棱两可的「外观描述」规范化成客户会搜索的标准行业名词（如 Panini 的 **碎冰红 / Red Ice**）。

本文档是**权威设计文档**：需求或实现变化时必须与正文同步更新（遵循 `keep-design-doc-in-sync` 习惯）。

## 业务背景与痛点

- 球星卡存在大量**折射**种类。每种折射 = **固定图案（pattern）+ 固定颜色（color）**，行业有固定的**专业名词**。
  - 例：Panini Prizm 系列有 银折(Silver) / 碎冰(Ice) / 碎冰红(Red Ice) / 金折(Gold) 等。
- 大模型看图后常输出**描述性泛词**（如「红色水晶裂纹闪闪的折」），而不是行业术语。
- 结果：客户用行业词（「碎冰红」）搜索时**搜不到你的链接**，上架等于白上。

## 核心目标

把「卡面折射外观」→「客户可搜索的规范专业名词」，并保证**同图案不同颜色 = 独立折射规格**（碎冰银 / 碎冰红 / 碎冰蓝 各自算一种）。

## 已锁定的方案决策

| 项 | 决策 |
|---|---|
| Agent 形态 | **独立新 Agent**，先独立产出，确认效果好后再对接 `card-agent` |
| 匹配方式 | **纯向量语义匹配**（描述 embedding → 相似度 → 标准名词） |
| 映射词典 | **员工填结构化词典**（按 品牌×系列 分桶），向量由程序对关键词自动生成 |
| 候选框 | 折射识别器**自判定品牌/年份/系列**（从反面 VLM 文本判定），自缩到对应桶 |
| VLM 输出 | **强制含「图案 + 颜色」结构化属性**，确保同图案不同颜色可区分 |
| 输入 | 卡片正面 + 反面原图 → VLM 识别输出文字信息 |
| 向量库落盘 | **外部向量库**（LanceDB / FAISS / pgvector 选一，首版倾向 LanceDB 轻量无服务） |
| 首版覆盖 | **Panini Prizm + Topps Chrome** 起步，跑通 schema 后按需扩展 |

## 目录结构

```
refractor-agent/
├── README.md                权威设计文档（本文件）
├── preset/
│   ├── preset.yml           Agent 预设元数据
│   └── agent.cordis.yml     装配清单（persona + 工具集）
├── skills/                  识别技能（源文件，按需拷入项目 .dsh/skills/）
│   ├── refractor-vlm/       VLM 识别指引：强制图案+颜色结构化 + 自判定品牌/年份/系列
│   └── refractor-match/     向量匹配、置信度与兜底规则
├── dicts/                   员工维护的结构化词典（品牌×系列分桶）
│   ├── schema.md            词典字段规范（本文档详述）
│   ├── panini-prizm.yml
│   └── topps-chrome.yml
├── scripts/
│   ├── embed.py             结构化词典 → 生成向量 → 写入向量库（幂等重建）
│   ├── match.py             文字描述 → embedding → 桶内向量匹配 → 标准名词（Python 对拍用）
│   └── run_batch.py         批量：一批卡片 → VLM 文本 → 匹配 → 结果/review
├── task-prompt.md           单项任务指令模板
└── db/                      向量库存量（LanceDB 数据库，由 embed.py 重建）
```

## 核心数据流

```
卡正 + 卡反 原图
  → [VLM] 识别 → 强制结构化文本输出：
      {
        "pattern": "碎冰",        # 图案类型（与词典对齐）
        "color":   "红",           # 颜色
        "brand":   "panini",       # 自判定品牌
        "year":    "2022",
        "series":  "prizm",        # 自判定系列
        "desc":    "红色水晶裂纹状折射"  # 自由外观描述（向量用）
      }
  → [embed] desc/关键词 → embedding 向量
  → 用 brand × series 自缩到对应词典桶
  → 在桶内做向量相似度匹配
  → 命中员工预置的标准名词（如 "碎冰红 Red Ice"）
  → 输出 {brand, series, refraction, pattern, color, matchScore}
  → 低置信 / 未命中 → 写入 review 清单，标记 needsReview
```

## 映射词典规范（dicts/schema.md）

员工只维护结构化词典，向量由程序生成。

```yaml
# dicts/panini-prizm.yml
brand: panini
series: prizm
year: 2022
refractions:
  - name: 碎冰红        # 标准名词（对外中文，客户搜索词）
    name_en: Red Ice    # 标准名词（英文）
    pattern: 碎冰        # 图案类型，必须与 VLM 输出的 pattern 对齐
    color: 红            # 颜色，必须与 VLM 输出的 color 对齐
    keywords:           # 员工补充的别名/变体写法
      - 碎冰红
      - red ice
      - ice red
  - name: 碎冰          # 同图案不同颜色 = 独立条目
    name_en: Ice
    pattern: 碎冰
    color: 无
    keywords: [碎冰, ice]
```

约定：
- **同图案不同颜色 = 独立条目**：`（pattern, color)` 在同一品牌的折射规格里必须唯一；程序以此检查词典冲突。
- VLM 的 `pattern` / `color` 取值与词典 `pattern` / `color` 受同一份受控枚举约束（由折射识别技能给出可选项，避免两边对不上）。
- 每条折射 → 用 `name / name_en / keywords` 走 embedding 模型生成一条向量（多词取平均或按权重合并）。
- `embed.py` 幂等重建：无增量需求时每次全量重build，保证词典改动后向量不含脏数据。

## 输出规范

结果采用 JSONL 每股一行，字段：

```json
{
  "cardId": "xxx",            // 卡片标识
  "brand": "panini",
  "series": "prizm",
  "year": "2022",
  "refraction": "碎冰红",      // 标准名词（对外）
  "name_en": "Red Ice",
  "pattern": "碎冰",
  "color": "红",
  "matchScore": 0.87,
  "needsReview": false
}
```

- 低置信（`matchScore` 低于阈值）或未命中 → `needsReview: true`，并追加到 `review.jsonl`。
- 未识别出折射（平卡/non-parallel）→ `refraction: null`，不算失败。

## 置信度与兜底

- 桶内匹配分阈值（默认 0.85，可配置）决定直接采纳还是进 review。
- 未命中兜底：把 `brand×series` 桶外扩到全量再试一次，仍不中就进 review。
- `needsReview` 项由员工复核后，把正确折射补进词典关键词，下次自动命中。

## 运行方式

```sh
# 需要环境变量（OpenAI 兼容端点）
#  DEEPSEEK_API_KEY / VLM_BASE_URL / VLM_MODEL / EMBED_MODEL

# 1. 员工维护好 dicts/*.yml 后，重建向量库
python scripts/embed.py

# 2. 单项任务（单个前+后）
pnpm dsh --profile refractor headless "按照 task-prompt.md 处理目录 {item_path}，结果写 {out_path}"

# 3. 批量（manifest 状态机断点续跑，参照 card-agent/batch_runner.py 思路）
python scripts/run_batch.py
```

## 已确认 vs 仍开放

- [x] 独立 Agent、纯向量匹配、结构化词典、自判定候选框、强制图案+颜色
- [x] 向量库落盘：**外部向量库**（首版倾向 LanceDB）
- [x] 首版覆盖：Panini Prizm + Topps Chrome
- [ ] embedding 模型最终选型（OpenAI 兼容 embeddings endpoint，型号待定）
- [ ] 与 card-agent 的对接方式（确认效果好后再定）