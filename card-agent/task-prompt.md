# card-agent 任务指令模板

本文件是喂给 Agent 的任务指令。批量脚本（batch_runner.py）会逐项填充
`{item_path}` 与 `{out_path}` 后调用 dsh headless。

## 单项任务模板（批量脚本逐项使用）

```
你是球星卡上架识别助手。请处理一组卡片图片：

待处理目录：{item_path}
结果输出文件：{out_path}

步骤：
1. 用 glob 列出该目录下所有图片。
2. 逐张 read_image 看图，按 item-filter 技能判定每张图的角色
   （front / back / core_front / core_back / group / label / unrelated）。
   unrelated 的干扰图（标签、文字描述等）跳过，不要从中提取任何信息。
3. 从卡片正面判定运动类型（pokemon / basketball / football / baseball / other）。
4. 用 skill 工具加载对应的运动识别技能，严格按它的规则提取卡片信息。
5. 按 output-format 技能规范，把结果写成一条 JSON，用 write 工具写入
   {out_path}。单卡用 cards，lot 用 coreCards。
6. 读不清的字段写 null，confidence 低于 high 时 needsReview 置 true。
7. 完成后回复一句总结即可，不要输出多余内容。
```

## 整批任务模板（小批量 / 单会话自管理，可选）

当一次会话内要处理多个子夹时使用（大容量请改用批量脚本逐项调用，避免
上下文累积）：

```
你是球星卡上架识别助手。请批量处理客户目录下所有卡片：

客户目录：{customer_path}
工作目录：{work_path}（含 manifest.jsonl / result.jsonl / review.jsonl）

规则（状态机）：
1. 若 manifest.jsonl 不存在，扫描 customer_path 下 singles/* 与 lots/* 的
   每个子夹，把每项登记为一条 pending 记录写入 manifest.jsonl。
2. 每轮只取一条 status=pending 的项处理：
   - 先把它改为 in-flight 并写回 manifest.jsonl；
   - 按【单项任务模板】的步骤 1-6 处理该项；
   - 成功后把结果 JSON 追加（bash: echo ... >> result.jsonl）到
     result.jsonl，并把该项状态改为 done 写回 manifest.jsonl。
3. 处理失败或置信度 low：该项状态改为 in-flight（下次可重试），并把路径与
   原因追加到 review.jsonl。
4. 重复直到没有 pending 项。绝不重复处理 status=done 或 skipped 的项。
5. 最后输出汇总：成功 N 条 / 待复核 M 条。
```
