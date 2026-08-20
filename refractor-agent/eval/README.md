# refractor-agent 效果评估（Evaluation）

本文档定义如何量化 refractor-agent 的「效果」——即 README 里「确认效果好后再对接
card-agent」的那个「效果」用什么标准衡量、怎么测。需求或实现变化时必须与正文同步更新。

## 目标

1. **量化**：给出可复现的准确率/召回率/复核率数字，而不是「看起来还行」。
2. **校准**：用真实样本标定匹配阈值（`--threshold` 默认 0.85 只是初始值）。
3. **回归**：词典、提示词、阈值改动后重跑，防止「改一个词坏一片」。
4. **决策门槛**：达到门槛（默认见下方「通过门槛」）才允许对接 card-agent。

## 两层评测

把「识别」和「匹配」拆开，可以单独定位问题出在哪一环。

### 1) 匹配层（match-layer）——离线、免费、确定性

输入是**预录的结构化识别结果**（`rec`），直接走 `match.py` 的匹配逻辑，与真实卡片图
无关。词典、阈值、兜底逻辑的改动都在这一层验证，秒级出结果，不消耗 VLM/embedding
调用（embedding 仍需，除非本地 fallback）。

### 2) 全链路（live）——真实卡片图

输入是**卡片正反面图片**，先 `vlm.recognize()` 再匹配。衡量「VLM 识别 + 匹配」整体
效果。需要 `VLM_*` 环境变量和图片文件。

## 数据格式（eval/golden.yaml）

每一条 case 是「一张卡 + 期望答案」。期望答案只填**员工可判定的字段**，其余留空不参与
统计：

```yaml
cases:
  - id: prizm-001
    front: images/prizm-001-front.jpg   # 相对 images_root（可 --images-root 覆盖）
    back: images/prizm-001-back.jpg
    expected:
      refraction: 碎冰红        # 标准名词；平卡写 null
      pattern: 碎冰
      color: 红
      brand: panini
      series: prizm
      year: 2022
    rec:                        # 可选：预录的 VLM 识别结果（匹配层评测用）
      pattern: 碎冰
      color: 红
      brand: panini
      year: 2022
      series: prizm
      desc: 红色水晶裂纹状折射，光线下反光
```

- `rec` 缺省时该 case 只能用于 live 模式；图片缺省时该 case 只能用于 match 模式
  （live 模式会跳过并提示）。
- **平卡**：`expected.refraction: null` + `pattern: 平卡`，用于测「识别为平卡不算失败」。
- **待复核样例**：可加 `expected.needsReview: true`，用于测「低置信该进 review 而非硬猜」。

## 指标

| 指标 | 定义 |
|---|---|
| `det_acc` | 判定「有折射/平卡」是否正确（refraction 非空 vs null） |
| `term_acc` | 非平卡中，预测 `refraction` 与期望**标准名词完全一致**的比例 |
| `pattern_acc` / `color_acc` | 图案 / 颜色字段正确率 |
| `bucket_acc` | brand+series 自判定正确率 |
| `review_rate` | 被标记 needsReview 的比例（期望低：表示大多直接命中） |
| `precision` | 返回了名词的项中，正确的比例（越少瞎猜越好） |
| `recall` | 应有名词的项中，正确返回的比例（越少漏掉越好） |
| `term_confusion` | 每对「期望 → 实际」的混淆次数（找系统性错误用） |

## 阈值校准（--sweep）

在 0.50 ~ 0.95 区间扫描阈值，输出每档的 `term_acc / review_rate / recall` 三列。
选点原则：
- `review_rate` 不过高（员工复核负担）；
- `recall` 不过低（漏匹配）；
- 两者权衡后取一个阈值写入 README 与 `refract_store.REMOTE_THRESHOLD`。
阈值属于「部署可调」配置，扫描结果只用于决策，不硬编码到代码。

## 通过门槛（对接 card-agent 的前置）

在正式金标集（每系列 ≥ 20 条真实卡）上：
- `term_acc` ≥ 0.85；
- `review_rate` ≤ 0.15；
- 无「高危错误」：预测出的折射名词**不是**该系列真实存在规格（如 Prizm 里出现
  「脉冲」）→ 属必须修的问题。
未达门槛则继续补词典 keywords、修提示词，重跑回归。

## 运行

```sh
# 匹配层（离线，需已 embed 建库；可只带 rec 的 case）
python scripts/evaluate.py --mode match --golden eval/golden.yaml

# 全链路（需 VLM_* 环境变量 + 图片）
python scripts/evaluate.py --mode live --golden eval/golden.yaml --images-root <dir>

# 阈值校准
python scripts/evaluate.py --mode match --sweep

# 输出目录（默认 eval/out/）：metrics.json / errors.jsonl / confusion.json
```

## 与 review 闭环的关系

生产里 `review.jsonl` 的待复核项 = 天然的负样本来源。员工复核后：
- 补 `keywords` 到词典 → `embed.py` 重建 → 重跑 `--mode match` 验证是否命中；
- 把复核过的真实 case 沉淀进 `golden.yaml`，持续扩大金标集。
这样评估集随经营数据一起增长，而不是一次性工程。
