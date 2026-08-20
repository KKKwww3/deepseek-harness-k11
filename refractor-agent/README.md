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
| 匹配方式 | **纯文本向量语义匹配**：查询 = `pattern + color + desc`；向量库由词典关键词生成 |
| embedding 模型 | **火山方舟 `doubao-embedding-vision-251215`**（OpenAI 兼容多模态端点，2048 维） |
| 图片是否入向量 | **否**。图片只用于 VLM 识别，不做图片 embedding——实拍光线/角度/颜色漂移大，且同卡复售概率低；折射关键词足以区分 |
| VLM 模型 | **火山方舟 `doubao-seed-2-0-lite-260428`**（`/api/v3/responses`，本地图走 base64 data URI） |
| 映射词典 | **员工填结构化词典**（按 品牌×系列 分桶），向量由程序对关键词自动生成 |
| 候选框 | 折射识别器**自判定品牌/年份/系列**（从反面 VLM 文本判定），自缩到对应桶 |
| VLM 输出 | **强制含「图案 + 颜色」结构化属性**，确保同图案不同颜色可区分 |
| 受控枚举 | **单一事实源 `dicts/enum.yml`**：VLM 提示词由它程序化生成，`embed.py` 校验词典值 |
| 输入 | 卡片正面 + 反面原图 → VLM 识别输出文字信息 |
| 向量库落盘 | **外部向量库**（首版 **LanceDB**，`db/refractors.lance`，`embed.py` 幂等重建） |
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
│   ├── refractor-vlm/       VLM 识别指引：强制图案+颜色结构化 + 自判定品牌/年份/系列
│   └── refractor-match/     向量匹配、置信度与兜底规则
├── dicts/                   员工维护的结构化词典（品牌×系列分桶）
│   ├── enum.yml             受控枚举（pattern/color 单一事实源）
│   ├── schema.md            词典字段规范（本文档详述）
│   ├── panini-prizm.yml
│   └── topps-chrome.yml
├── eval/
│   ├── README.md            效果评估设计文档
│   ├── golden.yaml          金标数据集（每系列 ≥ 20 条目标）
│   └── images/              金标图片（不入库，.gitignore 忽略）
├── scripts/
│   ├── refract_store.py     向量库 + Embedder（火山方舟多模态端点）+ .env 加载
│   ├── vlm.py               VLM 识别（Responses API，提示词由 enum.yml 生成）
│   ├── embed.py             结构化词典 → 生成向量 → 写入向量库（幂等重建 + 枚举校验）
│   ├── match.py             文字描述 → embedding → 桶内向量匹配 → 标准名词
│   ├── evaluate.py          金标集评测 + 阈值校准（见 eval/README.md）
│   └── run_batch.py         批量：一批卡片 → VLM 文本 → 匹配 → 结果/review
├── task-prompt.md           单项任务指令模板
└── db/                      向量库存量（LanceDB 数据库，由 embed.py 重建，不入库）
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

- 桶内匹配分阈值（默认 0.70，已按 doubao-embedding-vision 用 `--sweep` 校准；
  可配置 `--threshold`）。低于阈值 → 进 review。
- 未命中兜底：把 `brand×series` 桶外扩到全量再试一次，仍不中就进 review。
- `needsReview` 项由员工复核后，把正确折射补进词典关键词，下次自动命中。
- ⚠️ 阈值随 embedding 模型和金标集变化：扩充金标集后务必重跑
  `scripts/evaluate.py --sweep` 复核（见 `eval/README.md`）。

## 运行方式

```sh
# 前置
pip install -r refractor-agent/requirements.txt

# 环境变量（OpenAI 兼容端点；脚本会自动加载 refractor-agent/.env 或 cwd/.env）
#  DEEPSEEK_API_KEY / VLM_BASE_URL / VLM_API_KEY / VLM_MODEL / EMBED_BASE_URL / EMBED_API_KEY / EMBED_MODEL
# 也可手动：set -a; source .env; set +a

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

- [x] 独立 Agent、纯文本向量匹配、结构化词典、自判定候选框、强制图案+颜色
- [x] 向量库落盘：外部向量库（LanceDB）
- [x] embedding 模型选型：火山方舟 `doubao-embedding-vision-251215`（图片不入向量）
- [x] VLM 选型：火山方舟 `doubao-seed-2-0-lite-260428`（Responses API）
- [x] 受控枚举单一事实源 `dicts/enum.yml`（VLM 提示词程序化生成 + embed 校验）
- [x] 效果度量：金标集 + `scripts/evaluate.py`（匹配层 / 全链路 / 阈值校准）
- [x] 首版覆盖：Panini Prizm + Topps Chrome
- [ ] 金标集扩充到每系列 ≥ 20 条真实卡，跑通并通过「通过门槛」（见 eval/README.md）
- [ ] 与 card-agent 的对接方式（确认效果好后再定）