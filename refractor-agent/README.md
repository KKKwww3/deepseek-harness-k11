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
| 匹配方式 | **纯文本向量语义匹配**：查询 = `pattern + color + desc`；向量库存**全局折射类型**（每类型一条），再按 品牌×系列 查命名表出标准名词 |
| embedding 模型 | **火山方舟 `doubao-embedding-vision-251215`**（OpenAI 兼容多模态端点，**1024 维**，MRL 降维以适配 pgvector HNSW 的 2000 维上限） |
| 图片是否入向量 | **否**。图片只用于 VLM 识别，不做图片 embedding——实拍光线/角度/颜色漂移大，且同卡复售概率低；折射关键词足以区分 |
| VLM 模型 | **火山方舟 `doubao-seed-2-0-lite-260428`**（`/api/v3/responses`，本地图走 base64 data URI） |
| 映射词典 | **单文件 `dicts/refractions.yml`**：一行 = 一条数据库记录（pattern/color/keywords/names） |
| 候选框 | 折射识别器**自判定品牌/系列**（从反面 VLM 文本判定），决定命名取哪个系列；**无 year**（折射规格跨年份一致） |
| VLM 输出 | **强制含「图案 + 颜色」结构化属性**，确保同图案不同颜色可区分 |
| 受控枚举 | **自动推导**：pattern/color 合法集 = `dicts/refractions.yml` 已登记折射的取值（+平卡/其他、无/其他），无需单独枚举文件 |
| 输入 | 卡片正面 + 反面原图 → VLM 识别输出文字信息 |
| 向量库落盘 | **外部向量库**：**Supabase pgvector**（云端持久，`VECTOR_STORE=pgvector`，表 `refractor_types`）；`VECTOR_STORE=lance` 可切本地 LanceDB 兜底。`embed.py` 幂等重建 |
| 效果度量 | **金标集 + `scripts/evaluate.py`**（见 `eval/README.md`），达门槛后才对接 card-agent |
| 首版覆盖 | **Panini Prizm + Topps Chrome** 起步，跑通 schema 后按需扩展 |

## 目录结构

```
refractor-agent/
├── README.md                权威设计文档（本文件）
├── requirements.txt         脚本 Python 依赖
├── preset/
│   ├── preset.yml           Agent 预设元数据
│   └── agent.cordis.yml     装配清单（persona + 工具集）
├── skills/                  识别技能（源文件，按需拷入项目 .dsh/skills/）
│   ├── refractor-vlm/       VLM 识别指引：强制图案+颜色结构化 + 自判定品牌/系列
│   └── refractor-match/     全局类型匹配 + 系列命名、置信度与 review 规则
├── dicts/                   员工维护的词典（单文件）
│   ├── refractions.yml      折射词典（一行 = 一条数据库记录，员工唯一维护文件）
│   └── schema.md            词典字段规范（本文档详述）
├── eval/
│   ├── README.md            效果评估设计文档
│   ├── golden.yaml          金标数据集（每系列 ≥ 20 条目标）
│   └── images/              金标图片（不入库，.gitignore 忽略）
├── scripts/
│   ├── refract_store.py     向量库（pgvector/lance 双后端）+ Embedder + .env 加载
│   ├── setup_db.py          初始化 pgvector：扩展 + 表 + HNSW 索引（幂等）
│   ├── vlm.py               VLM 识别（Responses API，枚举由 refractions.yml 自动推导）
│   ├── embed.py             refractions.yml → 生成向量 → 写入向量库（幂等重建 + 校验）
│   ├── match.py             文字描述 → embedding → 类型匹配 + 系列命名 → 标准名词
│   ├── add_type.py          一键登记新折射（自动写单文件 + 重建）
│   ├── evaluate.py          金标集评测 + 阈值校准（见 eval/README.md）
│   └── run_batch.py         批量：一批卡片 → VLM 文本 → 匹配 → 结果/review
├── task-prompt.md           单项任务指令模板
└── db/                      LanceDB 本地兜底向量库（VECTOR_STORE=lance 时用，不入库）
```

## 核心数据流

```
卡正 + 卡反 原图
  → [VLM] 识别 → 强制结构化文本输出：
      {
        "pattern": "碎冰",        # 图案类型（与词典对齐）
        "color":   "红",           # 颜色
        "brand":   "panini",       # 自判定品牌
        "series":  "prizm",        # 自判定系列
        "desc":    "红色水晶裂纹状折射"  # 自由外观描述（向量用）
      }
  → [embed] pattern+color+desc → embedding 向量
  → 折射类型向量匹配（向量库 = dicts/refractions.yml，每折射一条）
  → 按 brand × series 查系列命名表 → 该系列的标准名词（如 panini 的 "碎冰红 Red Ice"）
  → 输出 {brand, series, refraction, name_en, pattern, color, matchScore}
  → 低置信 / 类型未命中 / 命名表查不到 → 写入 review 清单，标记 needsReview
```

> 同一折射类型在不同系列叫法不同：如 (银折, 银) 在 Panini 叫「银折/Silver」、
> 在 Topps Chrome 叫「普折射/Refractor」——叫法按系列存，向量只存类型。

## 映射词典规范（dicts/schema.md）

**单文件 `dicts/refractions.yml`**，一行 = 一条数据库记录。无 `year`。

```yaml
refractions:
  - pattern: 碎冰            # 图案类型（新增即自动成为 VLM 枚举）
    color: 红                # 颜色
    keywords: [碎冰红, 红色碎冰, red ice]   # 别名/外观描述（向量用）
    names:                   # 对外叫法，按品牌×系列
      panini-prizm: {name: 碎冰红, name_en: Red Ice}
      topps-chrome: {name: 红折, name_en: Red}
aliases:                     # 版权文字 → names 的 key（新增品牌×系列才动）
  brands:
    panini: [PANINI, Panini]
  series:
    prizm: [PRIZM, PRIZM BASKETBALL]
```

约定：
- **一行一折射**：`(pattern, color)` 唯一（同图不同色 = 独立条目，碎冰银/碎冰红/碎冰蓝 各一条）。
- **枚举自动推导**：VLM 的 pattern/color 合法集 = 已登记折射的取值（+平卡/其他、无/其他），无单独枚举文件。
- **命名按系列**：`names` 里该系列没登记 = 该系列不卖这种折 → 匹配时进 review。
- `embed.py` 幂等重建：全量覆盖，保证词典改动后向量不含脏数据；改完只需跑一次。

## 输出规范

结果采用 JSONL 每股一行，字段：

```json
{
  "cardId": "xxx",            // 卡片标识
  "brand": "panini",
  "series": "prizm",
  "refraction": "碎冰红",      // 标准名词（对外，来自系列命名表）
  "name_en": "Red Ice",
  "pattern": "碎冰",
  "color": "红",
  "matchScore": 0.87,
  "needsReview": false
}
```

- 低置信（`matchScore` 低于阈值）、类型未命中、或命名表查不到（品牌/系列 unknown 或该系列不卖这种折）→ `needsReview: true`，并追加到 `review.jsonl`。
- 未识别出折射（平卡/non-parallel）→ `refraction: null`，不算失败。

## 置信度与兜底

- 全局类型匹配分阈值（默认 0.70，已按 doubao-embedding-vision 用 `--sweep` 校准；
  可配置 `--threshold`）。低于阈值 → 进 review。
- 命中类型但查不到命名：品牌/系列 unknown，或该系列命名表里没登记这种折 → 进 review。
- `needsReview` 项由员工复核后：在 `dicts/refractions.yml` 里补 keywords（或登记新折射 + 系列叫法），下次自动命中。
- ⚠️ 阈值随 embedding 模型和金标集变化：扩充金标集后务必重跑
  `scripts/evaluate.py --sweep` 复核（见 `eval/README.md`）。

## 运行方式

```sh
# 前置
pip install -r refractor-agent/requirements.txt

# 环境变量（脚本会自动加载 refractor-agent/.env 或向上逐级找 .env）
#  embedding/VLM:  EMBED_BASE_URL / EMBED_API_KEY / EMBED_MODEL / VLM_BASE_URL / VLM_API_KEY / VLM_MODEL
#  向量库:         VECTOR_STORE=pgvector|lance；pgvector 需要 SUPABASE_DB_URL
# 也可手动：set -a; source .env; set +a

# 0. 初始化云端向量库（仅 pgvector 需要；幂等，可重复跑）
python scripts/setup_db.py

# 1. 员工维护好 dicts/*.yml 后，重建向量库（含受控枚举校验）
python scripts/embed.py

# 2. 单项任务（单个前+后）
pnpm dsh --profile refractor headless "按照 task-prompt.md 处理目录 {item_path}，结果写 {out_path}"

# 3. 批量（manifest 状态机断点续跑，参照 card-agent/batch_runner.py 思路）
python scripts/run_batch.py --input <客户目录> --work <工作目录>

# 4. 效果评估（对接 card-agent 前的门槛，详见 eval/README.md）
python scripts/evaluate.py --mode match     # 匹配层（离线）
python scripts/evaluate.py --mode live      # 全链路（需 VLM 环境 + 金标图片）
python scripts/evaluate.py --mode match --sweep   # 阈值校准
```

## 已确认 vs 仍开放

- [x] 独立 Agent、纯文本向量匹配、自判定品牌/系列、强制图案+颜色
- [x] 词典单文件 `dicts/refractions.yml`（一行 = 一条数据库记录，含按系列叫法）；去掉 year
- [x] 枚举自动推导（pattern/color 合法集 = 已登记折射取值 + 平卡/其他、无/其他）
- [x] 向量库落盘：外部向量库 **Supabase pgvector**（云端持久），LanceDB 本地兜底
- [x] embedding 模型选型：火山方舟 `doubao-embedding-vision-251215`（图片不入向量）
- [x] VLM 选型：火山方舟 `doubao-seed-2-0-lite-260428`（Responses API）
- [x] 效果度量：金标集 + `scripts/evaluate.py`（匹配层 / 全链路 / 阈值校准）
- [x] 首版覆盖：Panini Prizm + Topps Chrome
- [ ] 金标集扩充到每系列 ≥ 20 条真实卡，跑通并通过「通过门槛」（见 eval/README.md）
- [ ] 与 card-agent 的对接方式（确认效果好后再定）