# card-agent — 球星卡批量上架识别方案

基于 DeepSeek Harness (dsh) 的批量球星卡识别 Agent。把一个客户文件夹里的
单卡 / lot 图片，批量识别成结构化 JSON/CSV。

## 目录

```
card-agent/
├── preset/
│   ├── preset.yml          Agent 预设元数据
│   └── agent.cordis.yml    装配清单（persona + 工具集）
├── skills/                 识别技能（源文件，按需拷入项目 .dsh/skills/）
│   ├── item-filter/       图片角色判定 + 干扰图过滤（每组处理前必读）
│   ├── pokemon/           宝可梦卡识别
│   ├── basketball/        篮球卡识别
│   ├── football/          足球卡识别
│   ├── baseball-other/    棒球/橄榄球等其他运动
│   └── output-format/     结果 JSON 输出规范
├── task-prompt.md          批量/单项任务指令模板
└── batch_runner.py         编排脚本：manifest 状态机 + 断点续跑 + CSV
```

## 输入结构（你预分类之后）

```
/客户A/
├── singles/
│   ├── 001/  front.jpg  back.jpg   （可能混入标签/文字描述等干扰图）
│   └── 002/  ...
└── lots/
    └── LOT-202/  group.jpg  label.jpg  core_front.jpg  core_back.jpg
```

- 你负责把图片按「单卡 / lot」分成 `singles/` 和 `lots/`（每组一个子夹）。
- Agent 负责：逐张判定角色 → 过滤干扰图 → 判定运动类型 → 加载对应技能 → 提取卡片信息。

## 核心机制：状态机 + 断点续跑（不会 token 爆炸、不会重复）

```
manifest（机器读写，不给模型读全文）：
  status: pending → in-flight → done
          干扰图判定后直接标记 skipped

批量流程：
  1. batch_runner 扫描 → 建立 manifest（pending）
  2. 逐项调用 dsh headless（每项独立会话，上下文只有"当前这组图+技能"）
  3. 每项完成 → 写单条 JSON → 更新 status=done
  4. 中断后重跑：只处理 pending；done/skipped 一律跳过 → 天然不重复
```

模型每步只看到「当前这一组的图片 + 对应技能」，与总图片量、干扰图数量无关。

## 运行步骤

1. 构建 dsh 并配置模型（仓库根 `.env` 放 `DEEPSEEK_API_KEY`）：
   ```sh
   pnpm install && pnpm run build
   ```
2. 安装技能：把 `skills/` 下各目录拷到你的项目根 `.dsh/skills/`
   （或按 README 中 skill-filesystem 的发现规则放到对应目录）。
3. 注册 card-lister 预设：把 `preset/` 拷入 `$DSH_HOME/.agent-presets/`。
4. 运行批量：
   ```sh
   python3 batch_runner.py --customer /path/to/客户A --out /path/to/输出
   ```

## 输出

- `result.jsonl`：每条上架记录一行 JSON（追加写，天然可恢复）
- `result.csv`：拍平为一卡一行的汇总表，供上架系统导入
- `manifest.jsonl`：每项处理状态（断点/回溯依据）
- `review.jsonl`：置信度低 / 识别失败，待人工复核的项
