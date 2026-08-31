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
| 运行时 | **Node/TS（`node/` 目录）为主实现**：DSH 类型化工具（`refractor_recognize` / `refractor_match` / `refractor_batch_run` / `refractor_batch_status`）+ SQLite 任务状态机；业务主路径不经过 bash。`scripts/` 下 Python 版为**退役参考实现**（行为契约来源，金标双跑一致后退役） |
| 匹配方式 | **纯文本向量语义匹配**：查询 = `pattern + color + desc`；**Supabase pgvector 服务端检索**（`<=>` 余弦）返回 top1 命中，再从数据库 `refraction_names` 按 品牌×系列 查标准名词；本地 LanceDB 兜底时在运行时内比对 |
| embedding 模型 | **火山方舟 `doubao-embedding-vision-251215`**（OpenAI 兼容多模态端点，**1024 维**，MRL 降维以适配 pgvector HNSW 的 2000 维上限） |
| 图片是否入向量 | **否**。图片只用于 VLM 识别，不做图片 embedding——实拍光线/角度/颜色漂移大，且同卡复售概率低；折射关键词足以区分 |
| VLM 模型 | **火山方舟 `doubao-seed-2-0-lite-260428`**（`/api/v3/responses`，本地图走 base64 data URI） |
| 映射词典 | **单文件 `dicts/refractions.yml`**：一行 = 一条数据库记录（pattern/color/keywords/names） |
| 候选框 | 折射识别器**自判定品牌/系列**（从反面 VLM 文本判定），决定命名取哪个系列；**无 year**（折射规格跨年份一致） |
| VLM 输出 | **强制含「图案 + 颜色」结构化属性**，确保同图案不同颜色可区分 |
| 受控枚举 | **自动推导**：pattern/color 合法集 = `dicts/refractions.yml` 已登记折射的取值（+平卡/其他、无/其他），无需单独枚举文件 |
| 输入 | 卡片正面 + 反面原图 → VLM 识别输出文字信息 |
| 向量库落盘 | **外部向量库**：**Supabase pgvector**（云端持久，`VECTOR_STORE=pgvector`，表 `refractor_types` + 命名表 `refraction_names`）；`VECTOR_STORE=lance` 可切本地 LanceDB 兜底。embed 幂等重建 |
| 效果度量 | **金标集 + evaluate**（TS `node/src/evaluate.ts` 与 Python `scripts/evaluate.py`，见 `eval/README.md`），达门槛后才对接 card-agent |
| 首版覆盖 | **Panini Prizm + Topps Chrome** 起步，跑通 schema 后按需扩展 |

## 目录结构

```
refractor-agent/
├── README.md                权威设计文档（本文件）
├── node/                    Node/TS 主实现（详见 node/README.md）
│   ├── src/schemas.ts       VLM 响应防火墙：字段/枚举/组合/平卡校验
│   ├── src/vlm.ts           VLM 适配：上限、错误分类、双模式重试
│   ├── src/store.ts         Embedder + pgvector/lance 双后端 + 指纹自愈
│   ├── src/match.ts         匹配决策（top1 + 阈值 + 系列命名 + review 路由）
│   ├── src/embed.ts         词典 → 向量库（幂等重建，CLI 含）
│   ├── src/evaluate.ts      金标评测（match 模式，指标与 Python 逐项一致）
│   ├── src/jobStore.ts      SQLite 事务任务状态机（lease/幂等/事件审计）
│   ├── src/batch.ts         批处理编排（失败分类，CLI 含）
│   ├── src/tools.ts         领域工具层（recognize/match/batch_run/batch_status）
│   ├── src/dshPlugin.ts     DSH function plugin 入口（bundle → dist/refractor-plugin.mjs）
│   └── tests/               vitest 测试（97 项）+ Python 奇偶校验 fixtures
├── requirements.txt         Python 参考实现依赖（已退役，仅参考）
├── requirements.lock        同上（全量锁定）
├── preset/
│   ├── preset.yml           Agent 预设元数据
│   └── agent.cordis.yml     装配清单（persona + 类型化工具 + 技能；安装副本 → apps/cli/config/agent-presets/refractor/）
├── skills/                  识别技能源文件（安装副本 → 项目根 .dsh/skills/）
│   ├── refractor-vlm/       VLM 识别指引：强制图案+颜色结构化 + 自判定品牌/系列
│   └── refractor-match/     全局类型匹配 + 系列命名、置信度与 review 规则
├── dicts/                   员工维护的词典（单文件构建源，与运行时无关）
│   ├── refractions.yml      折射词典（生成向量表与命名表）
│   └── schema.md            词典字段规范（本文档详述）
├── eval/
│   ├── README.md            效果评估设计文档
│   ├── golden.yaml          金标数据集（每系列 ≥ 20 条目标）
│   └── images/              金标图片（不入库，.gitignore 忽略）
├── scripts/                 ⚠️ Python 参考实现（已退役；行为契约与对照基线）
│   ├── refract_store.py     向量库与命名表（pgvector/lance 双后端）+ Embedder + .env 加载
│   ├── setup_db.py          初始化 pgvector：扩展 + 向量表 + 命名表 + HNSW 索引（幂等）
│   ├── vlm.py               VLM 识别（Responses API，枚举由 refractions.yml 自动推导）
│   ├── embed.py             refractions.yml → 生成向量与命名记录 → 写入数据库（幂等重建 + 校验）
│   ├── match.py             文字描述 → embedding → 类型匹配 + 数据库系列命名 → 标准名词
│   ├── add_type.py          一键登记新折射（自动写单文件 + 重建）
│   ├── evaluate.py          金标集评测 + 阈值校准（见 eval/README.md）
│   └── run_batch.py         批量：一批卡片 → VLM 文本 → 匹配 → 结果/review
├── task-prompt.md           任务指令模板（单项 / 整批，工具流）
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
  → 折射类型向量匹配（数据库 `refractor_types`，每折射一条）
  → 查询数据库 `refraction_names`（brand × series × pattern × color）
  → 该系列的标准名词（如 panini 的 "碎冰红 Red Ice"）
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
```

约定：
- **一行一折射**：`(pattern, color)` 唯一（同图不同色 = 独立条目，碎冰银/碎冰红/碎冰蓝 各一条）。
- **枚举自动推导**：VLM 的 pattern/color 合法集 = 已登记折射的取值（+平卡/其他、无/其他），无单独枚举文件。
- **命名按系列**：`names` 由 `embed.py` 展开写入数据库 `refraction_names`；运行时按 brand × series × pattern × color 查询。该系列没登记 = 该系列不卖这种折 → 匹配时进 review。品牌/系列由 VLM 纯文本稳定返回（脚本小写 + 去空白归一化），无需别名表。
- **`embed.py` 幂等重建**：全量覆盖 `refractor_types` 与 `refraction_names`，保证词典改动后运行时数据库不含脏数据；改完只需跑一次。

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

## 安装到 DeepSeek Harness（DSH web / headless）

refractor-agent 是 DSH 标准 Agent：**preset（persona+工具组合）+ 两个技能**。安装 = 复制两份副本到运行时的发现根（源文件始终以 `refractor-agent/` 为准）：

```sh
# ① 注册 Agent preset（部署自带目录，web 的 agent 列表会出现「折射名词规范化助手」）
mkdir -p apps/cli/config/agent-presets/refractor
cp refractor-agent/preset/agent.cordis.yml refractor-agent/preset/preset.yml \
   apps/cli/config/agent-presets/refractor/

# ② 安装技能（项目根 .dsh/skills，skill-filesystem 的 project-dsh 根）
mkdir -p .dsh/skills
cp -r refractor-agent/skills/refractor-vlm refractor-agent/skills/refractor-match .dsh/skills/
```

> - 两个位置均已入库（部署自带）；**改源文件（refractor-agent/preset 或 skills）后要同步副本**。
> - preset 发现每次调用重扫文件系统（无需重启）；skill 目录若在进程启动后新建，需重启 `dsh web`（PM2: `pm2 restart dsh-web`）让 watcher 重建。
> - 装好后在 web 新建会话即可选择「折射名词规范化助手」Agent，技能 `refractor-vlm` / `refractor-match` 自动进入该会话目录。

## 安装到 DeepSeek Harness（DSH web / headless）

refractor-agent 是 DSH 标准 Agent：**preset（persona + 类型化领域工具 + 技能）**。工具由 preset 自带插件提供（绝对路径行指向 `refractor-agent/node/dist/refractor-plugin.mjs`，其依赖从 `refractor-agent/node/node_modules` 向上解析）。安装：

```sh
# ① 构建 preset 插件（改动 node/ 源码后重跑）
cd refractor-agent/node && npm install && npm run build

# ② 安装 preset 到【用户发现根】——web/headless 默认扫描
#    <DSH_HOME>/.agent-presets（本部署 DSH_HOME=/root/.dsh）；
#    apps/cli/config/agent-presets 仅作仓库内参考副本，默认不在发现根上
mkdir -p /root/.dsh/.agent-presets/refractor
cp refractor-agent/preset/agent.cordis.yml refractor-agent/preset/preset.yml \
   /root/.dsh/.agent-presets/refractor/

# ③ 安装技能（项目根 .dsh/skills，skill-filesystem 的 project-dsh 根）
mkdir -p .dsh/skills
cp -r refractor-agent/skills/refractor-vlm refractor-agent/skills/refractor-match .dsh/skills/

# ④ 重启 web 让 preset 出现在 agent 选择器（PM2: pm2 restart dsh-web）
```

> - 插件行是**绝对路径**：installed copy 无论放在哪个发现根都能解析到构建产物；改 node/ 源码后只需 `npm run build`（无需重拷 preset）。
> - 改 preset.yml / agent.cordis.yml / skills 源文件后要同步副本；skill 目录新建需重启 `dsh web`。
> - preset 包名行（persona / tool-fs 等）从 **harness 安装目录** 的 node_modules 解析（本部署即 /root/.dsh/profiles/web 向上）。
> - 发现健康检查 fail-closed：preset 若损坏会带原因出现在选择器，而不是静默消失。
> - 冒烟证据（本轮已验）：`discoverPresets` 真实代码输出 `preset refractor [user] healthy name=折射名词规范化助手`。

## 运行方式（Node 运行时）

```sh
# 前置（node/ 目录自管依赖，独立于仓库 pnpm workspace）
cd refractor-agent/node && npm install

# 测试 / 类型检查 / 构建 preset 插件
npm test            # vitest（97 项，含 Python 奇偶校验 fixtures）
npm run typecheck
npm run build       # → dist/refractor-plugin.mjs

# 环境变量（工具进程自动加载 refractor-agent/.env 或向上逐级找 .env）
#  embedding/VLM:  EMBED_BASE_URL / EMBED_API_KEY / EMBED_MODEL / VLM_BASE_URL / VLM_API_KEY / VLM_MODEL
#  向量库:         VECTOR_STORE=pgvector|lance；pgvector 需要 SUPABASE_DB_URL

# 0. 员工维护好 dicts/*.yml 后，重建向量库（幂等 + 受控枚举校验）
node src/embed.ts --dict-dir ../dicts          # 默认库；--db 可指定路径

# 1. 单项任务（单个前+后）：dsh 会话选 refractor preset，模型调
#    refractor_recognize / refractor_match 工具（见 task-prompt.md 模板）

# 2. 批量（SQLite 状态机断点续跑；也可在会话里调 refractor_batch_run）
node src/batch.ts --input <客户目录> --work <工作目录> [--dry-run]
#    环境变量：BATCH_MAX_ATTEMPTS=3（整项尝试上限 1..10）
#             BATCH_LEASE_MS=300000（worker 租约）
#             BATCH_RETRY_COOLDOWN_MS=5000（可重试失败的冷却）

# 3. 效果评估（对接 card-agent 前的门槛，详见 eval/README.md）
node src/evaluate.ts --mode match --golden ../eval/golden.yaml
#    （阈值校准 --sweep 尚在 TS 侧待补，可用 Python 参考实现跑）
```

### VLM 可靠性配置（均为部署级环境变量，模型请求不能自行修改）

```sh
VLM_TIMEOUT_SECONDS=180             # 单次请求超时
VLM_MAX_OUTPUT_TOKENS=500           # 模型输出 token 上限
VLM_MAX_PROVIDER_BYTES=262144       # 完整 provider 响应最大字节数
VLM_MAX_TEXT_BYTES=16384            # 提取后的模型文本最大 UTF-8 字节数
VLM_SCHEMA_RETRIES=1                # 格式/schema 错误最多补救一次
VLM_RETRY_MODE=same                 # same=原样重试；repair=原始指令追加错误说明
VLM_NETWORK_RETRIES=2               # 超时/网络/408/429/5xx 最多重试两次
VLM_RETRY_BACKOFF_SECONDS=1         # 指数退避：1s、2s；重试次数硬上限 10、退避硬上限 60s
```

VLM 结果先经过 JSON、字段类型、受控 pattern/color 枚举、组合合法性与平卡一致性校验，校验失败不会进入匹配层。模型文本或 provider 响应超限不会截断后继续解析；格式/schema 错误按 `VLM_RETRY_MODE` 处理：默认 `same` 原样重发一次（相同 Prompt、图片和模型参数，不修改识别语义），`repair` 在完整原始指令后追加一条校验错误说明再重试（只回传错误摘要，不回传原始错误输出）；完整 provider 响应超限直接失败。网络超时、连接错误、408、409、425、429 和 5xx 使用有限指数退避；认证、权限、其他 4xx 和业务枚举错误不自动重试。

## Python 参考实现（已退役）

`scripts/` 下的 Python 版本已**退役为参考实现**：Node 版以它为行为契约完成移植（97 项测试 + 金标双跑五阈值指标逐项一致，见 `node/README.md`），preset 不再引用它。保留用途：对照基线、`--sweep` 阈值校准、以及排查争议时的仲裁。不要在新功能上继续投入 Python 版；修复行为差异时以本 README 与测试为准同步两侧。

## 已确认 vs 仍开放

- [x] 独立 Agent、纯文本向量匹配、自判定品牌/系列、强制图案+颜色
- [x] 词典单文件 `dicts/refractions.yml`（一行 = 一条数据库记录，含按系列叫法）；去掉 year
- [x] 枚举自动推导（pattern/color 合法集 = 已登记折射取值 + 平卡/其他、无/其他）
- [x] 向量库落盘：外部向量库 **Supabase pgvector**（云端持久），LanceDB 本地兜底
- [x] embedding 模型选型：火山方舟 `doubao-embedding-vision-251215`（图片不入向量）
- [x] VLM 选型：火山方舟 `doubao-seed-2-0-lite-260428`（Responses API）
- [x] 效果度量：金标集 + evaluate（匹配层 / 全链路 / 阈值校准）
- [x] 首版覆盖：Panini Prizm + Topps Chrome
- [x] Node/TS 主实现：类型化工具 + SQLite 状态机；Python 退役为参考（金标双跑一致）
- [ ] 金标集扩充到每系列 ≥ 20 条真实卡，跑通并通过「通过门槛」（见 eval/README.md）
- [ ] 与 card-agent 的对接方式（确认效果好后再定）
- [ ] evaluate `--sweep` 阈值校准补齐到 TS 侧