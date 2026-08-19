# card-agent — 球星卡批量上架识别 Agent

基于 DeepSeek Harness (dsh) 的批量球星卡识别方案。把一个客户文件夹里的单卡 / lot
图片，批量识别成结构化 JSON / CSV。本文档是**权威设计文档**：需求或实现变化时必须
与正文同步更新（遵循项目内 `keep-design-doc-in-sync` skill）。

## 目录

```
card-agent/
├── preset/
│   ├── preset.yml          Agent 预设元数据
│   └── agent.cordis.yml    装配清单（persona + 工具集）
├── skills/                 识别技能（源文件，按需拷入项目 .dsh/skills/）
│   ├── item-filter/        图片角色判定 + 干扰图过滤（每组处理前必读）
│   ├── pokemon/            宝可梦卡识别
│   ├── basketball/         篮球卡识别
│   ├── football/           足球卡识别
│   ├── baseball-other/     棒球/橄榄球等其他运动
│   └── output-format/      结果 JSON 输出规范
├── preclassifier.py        可扩展预分类层（YOLO 本地 / VLM OpenAI 兼容多图批量）
├── task-prompt.md          单项任务指令模板
└── batch_runner.py         编排脚本：manifest 状态机 + 断点续跑 + CSV
```

## 业务背景与范围

- **输入**：一个客户文件夹，含 `singles/`（单卡）与 `lots/`（批量 lot），每组一个子夹。
  - 单卡：一张正面 + 一张反面，**子夹内可能混入标签、文字描述等干扰图**。
  - lot：整组合照、包装袋+编号图、核心卖点正面/反面，可能多张，也可能混入干扰图。
  - lot 合照可能多达 25 张卡；核心卖点通常 3~4 张。
- **输出**：结构化的单卡 / lot 上架记录（JSON 行文件 + CSV）。
- **支持运动**：宝可梦、篮球、足球、棒球、橄榄球等。
- **分工**：预分类（人/脚本）只区分单卡与 lot；**干扰图识别与过滤由 Agent 自动完成**。
- **明确不做**：预分类阶段不识别卡片内容（卡名/卡号/系列由后段 VLM/技能完成）。

## 核心机制

### 1. 分层处理流水线

```
① 预分类层（可选，YOLO 本地 / VLM OpenAI 兼容）
   对每组每张图判角色 → 全干扰组直接标 skipped，不启动模型
② 编排层 batch_runner
   扫描登记 manifest → 逐项调 dsh headless → 合并 result → 导出 CSV
③ 会话层（模型，只处理正常卡）
   item-filter 判定角色 → 判运动 → 加载对应技能 → 提取 → 按 output-format 写 JSON
```

### 2. Manifest 状态机（断点续跑 + 不重复 + 不 token 爆炸）

```
manifest（机器读写，不给模型读全文）：
  status: pending → in-flight → done
          全干扰组 → skipped（不启动模型，省一次调用）
```

- 批量流程：扫描建立 manifest（pending）→ 逐项调 dsh headless（每项独立会话）→
  完成写单条 JSON + status=done → 中断后重跑只处理 pending / in-flight。
- 模型每步只看到「当前这一组的图片 + 对应技能」，与总图片量、干扰图数量无关。
- **幂等**：done / skipped 一律跳过，重跑不重复。

### 3. 预分类层（可切换：none / yolo / vlm）

统一接口 `classify(images) -> dict[文件名, 角色]`，注册表 + 工厂模式，新增方式只加一个类。

| 模式 | 说明 | 关键参数 |
|---|---|---|
| `none`（默认） | 不预分类，角色判定全交给模型 | — |
| `yolo` | YOLO 本地分类模型逐图判角色 | `--yolo-model` `--yolo-conf` |
| `vlm` | 任意 OpenAI 兼容视觉端点，**一次请求带多图批量判定** | `--vlm-endpoint` `--vlm-model` `--vlm-api-key` `--vlm-batch-size` |

- 角色集合（固定 7 类）：`single_front single_back lot_group lot_label core_front core_back unrelated`。
- **只判角色，不识别卡片内容**；YOLO 不按球员/折射训练（那是 VLM 的事）。
- VLM 返回 `{文件名: 角色}` JSON 映射，整批失败兜底 `unrelated`。
- 全干扰组 → skipped；正常组的角色清单作为提示注入 agent（复核沿用）。

### 4. 异常与兜底

- 单张图识别失败 → 跳过、记入结果，不打断批量。
- 整项识别失败 → 记入 review.jsonl，状态回 in-flight（下次可重试）。
- 低置信度 → `needsReview: true`，不中断。
- 只有「不问你无法继续」时才用 ask-user 兜底。

## 运行

### 前置

1. 构建 dsh 并配置模型（仓库根 `.env` 放 `DEEPSEEK_API_KEY`）：
   ```sh
   pnpm install && pnpm run build
   ```
2. 安装技能：把 `skills/` 下各目录拷到你的项目根 `.dsh/skills/`。
3. 注册预设：把 `preset/` 拷入 `$DSH_HOME/.agent-presets/`。

### 命令示例

```sh
# 无预分类
python3 batch_runner.py --customer /客户A --out /输出A --customer-id A

# YOLO 预分类
python3 batch_runner.py --customer /客户A --out /输出A --customer-id A \
  --preclassify yolo --yolo-model /path/model.pt --yolo-conf 0.5

# VLM 预分类（OpenAI 兼容，一次多图）
python3 batch_runner.py --customer /客户A --out /输出A --customer-id A \
  --preclassify vlm \
  --vlm-api-key sk-xxx \
  --vlm-endpoint https://open.bigmodel.cn/api/paas/v4/chat/completions \
  --vlm-model glm-4v-flash --vlm-batch-size 8
```

### 断点续跑

直接重跑同一命令即可。脚本只处理 manifest 中 pending / in-flight 的项，done / skipped
一律跳过，天然幂等。

## 输出

- `result.jsonl`：每条上架记录一行 JSON（追加写，天然可恢复）
- `result.csv`：拍平为一卡一行的汇总表，供上架系统导入
- `manifest.jsonl`：每项处理状态（断点/回溯依据）
- `review.jsonl`：识别失败，待人工复核的项
- `items/<key>.json`：每项单条结果
- `roles/<key>.json`：预分类角色清单（仅启用预分类时）

itemId 统一为 `{customerId}-{子夹名}`（如 `A-001`、`A-LOT-202`）。

## YOLO 训练（可选，为预分类提速）

任务为**图级角色分类**（7 类），不逐卡框选。类别固定：
`single_front single_back lot_group lot_label core_front core_back unrelated`

数据集：每类 100~300 张，**多种运动混合**（single_front 里放篮球+足球+宝可梦+棒球），
`unrelated` 类尽量多（各类标签/文字/包装袋特写）。训练：

```python
from ultralytics import YOLO
model = YOLO("yolov8n-cls.pt")
model.train(data="card-cls-dataset/", epochs=50, imgsz=640)
```