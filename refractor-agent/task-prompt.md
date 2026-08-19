# refractor-agent 任务指令模板
#
# 本文件是喂给 Agent 的任务指令。批量脚本（scripts/run_batch.py）会逐项
# 填充 `{item_path}` 与 `{out_path}` 后调用 dsh headless。

## 单项任务模板（单一前+后一组）

```
你是折射名词规范化助手。请处理一组卡片图片：

待处理目录：{item_path}
结果输出文件：{out_path}

步骤：
1. 用 glob 列出该目录下的图片，分辨出正面图与反面图（通常各一张）。
2. 用 refractor-vlm 技能同时看正/反面，识别折射外观，必须输出结构化
   { pattern, color, brand, year, series, desc }。图案与颜色取自受控枚举；
   brand/year/series 以反面版权信息为准。
3. 同图案不同颜色是不同折射（碎冰银/碎冰红/碎冰蓝各自独立），不要合并。
4. 调用 scripts/match.py，传入该结构化识别结果做向量匹配，得到标准名词。
5. 按 refractor-match 技能把结果写成一条 JSON，用 write 工具写入 {out_path}。
6. 匹配分低于阈值或无法判定 → needsReview 置 true，并按规范追加 review.jsonl。
7. 平卡（pattern=平卡）→ refraction 写 null，不算失败。
8. 完成后回复一句总结即可，不要输出多余内容。
```

## 整批任务模板（小批量 / 单会话自管理，可选）

检验 scripts/run_batch.py 之外的零散卡片用；大容量请走 run_batch.py
（manifest 状态机断点续跑），避免上下文累积。

```
你是折射名词规范化助手。请批量处理客户目录下所有卡片：

客户目录：{customer_path}
工作目录：{work_path}（含 manifest.jsonl / result.jsonl / review.jsonl）

规则（状态机）：
1. 若 manifest.jsonl 不存在，扫描 {customer_path} 下每组前+照片，登记为
   pending 记录写入 manifest.jsonl。
2. 每轮只取 status=pending 的一条处理：先改 in-flight，按【单项任务模板】
   处理，成功后结果 JSON 追加到 result.jsonl，并把该条置 done。
3. 处理失败或置信 low → 置 in-flight（可重试），路径与原因追加 review.jsonl。
4. 绝不重复处理 status=done 或 skipped 的项。
5. 最后输出汇总：成功 N 条 / 待复核 M 条。
```