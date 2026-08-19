# card-agent：球星卡批量识别 Agent

基于 DeepSeek Harness 的批量球星卡识别方案。客户图片按「单卡 / lot」预分类存放，Agent 逐项识别、过滤干扰图、按运动技能提取结构化数据，输出 JSON 行文件 + CSV，支持断点续跑。

## 目录结构

```
card-agent/
├── batch_runner.py      # 编排脚本：扫描 → manifest 状态机 → 逐项调 dsh → 合并导出
├── task-prompt.md       # 单项任务指令模板（{item_path}/{out_path}/{customer_id} 占位）
├── preset/              # card-lister Agent 预设
│   ├── preset.yml
│   └── agent.cordis.yml
├── skills/              # 识别技能（拷到项目根 .dsh/skills/）
│   ├── item-filter/     # 图角色判定 + 干扰过滤
│   ├── pokemon/         # 宝可梦
│   ├── basketball/      # 篮球
│   ├── football/        # 足球
│   ├── baseball-other/  # 棒球/橄榄球/其它
│   └── output-format/   # 结果 JSON 规范
└── README.md
```

## 输入结构（你预分类）

```
/客户A/
├── singles/        # 单卡，一组一个子夹
│   ├── 001/   front.jpg  back.jpg  (可能混入 tag.jpg 等干扰图)
│   └── 002/   ...
└── lots/           # lot，一组一个子夹
    └── LOT-202/  group.jpg  label.jpg  core_front.jpg  core_back.jpg
```

Agent 负责识别并跳过每组内混入的干扰图（`unrelated`），不移动你的原始图片。

## 运行

### 1. 不预分类（直接让模型判定角色）

```sh
python3 batch_runner.py \
  --customer /客户A \
  --out /输出A \
  --cmd dsh \
  --customer-id A
```

### 2. 用 YOLO 预分类（推荐，省 token）

```sh
python3 batch_runner.py \
  --customer /客户A --out /输出A --customer-id A \
  --preclassify yolo \
  --yolo-model /path/to/your-yolo-cls.pt \
  --yolo-conf 0.5
```

### 3. 用 GLM 视觉模型预分类

```sh
python3 batch_runner.py \
  --customer /客户A --out /输出A --customer-id A \
  --preclassify glm \
  --glm-api-key sk-xxx \
  --glm-endpoint https://open.bigmodel.cn/api/paas/v4/chat/completions \
  --glm-model glm-4v-flash
```

### 4. 中断后续跑

直接重跑同一命令即可。脚本只处理 manifest 中 `pending` / `in-flight` 的项，`done` / `skipped` 一律跳过，天然幂等。

## 预分类行为

- `--preclassify none`（默认）：角色判定全部交给模型，每组都会跑一次 headless。
- `--preclassify yolo`：用 YOLO 分类模型逐图判角色；某组全为 `unrelated` 时**直接标 skipped，不启动模型**（省一次调用）。角色清单写入 `out/roles/<key>.json` 并作为提示注入 prompt，模型复核沿用。
- `--preclassify glm`：同上，用 GLM 视觉模型逐图判角色（OpenAI 兼容端点，逐图 HTTP 调用）。
- YOLO/GLM 判定失败的图默认标 `unrelated` 兜底；低置信依赖 `--yolo-conf` 阈值与 review 队列。

## 输出

```
/输出A/
├── manifest.jsonl   # 每项状态：pending → in-flight → done / skipped
├── result.jsonl     # 每条识别记录（append-only，模型可见）
├── review.jsonl     # 识别失败项（下次重试）
├── items/<key>.json # 每项单条结果
├── roles/<key>.json # 预分类角色清单（仅启用预分类时）
└── result.csv       # 汇总（一卡一行，utf-8-sig 便于 Excel）
```

## 部署

构建 dsh 并配置 `DEEPSEEK_API_KEY`（见仓库根 README）。然后：

```sh
# 1. 技能：拷到项目根 .dsh/skills/
mkdir -p .dsh/skills && cp -r skills/* .dsh/skills/

# 2. 预设：拷到 agent-presets 目录（$DSH_HOME/.agent-presets/）
mkdir -p "$DSH_HOME/.agent-presets" && cp -r preset "$DSH_HOME/.agent-presets/card-lister"

# 3. 让 headless 使用 card-lister 预设（或 Web 模式手动选）
#    默认 headless 使用 standard 预设；批量脚本按需把 --cmd 换成
#    dsh --profile headless（配合 agent-presets 默认预设切换或 --patch）
```

## YOLO 训练（可选，为预分类提速）

任务为**图级角色分类**（7 类），不逐卡框选。类别固定：

`single_front single_back lot_group lot_label core_front core_back unrelated`

数据集结构（类别名即文件夹名，每类 100~300 张，多种运动混合）：

```
card-cls-dataset/
├── train/{single_front,single_back,lot_group,lot_label,core_front,core_back,unrelated}/
└── val/...
```

训练（需 `pip install ultralytics`）：

```python
from ultralytics import YOLO
model = YOLO("yolov8n-cls.pt")
model.train(data="card-cls-dataset/", epochs=50, imgsz=640)
```

`unrelated` 类建议多收集（各类标签、文字描述、包装袋特写），防止干扰图被误判成卡片图。
