#!/usr/bin/env python3
"""card-agent 批量识别编排脚本：manifest 状态机 + 断点续跑 + CSV 汇总。

用法：
  python3 batch_runner.py --customer /path/to/客户A --out /path/to/输出

前置条件：
  1. dsh 已构建并配置 DEEPSEEK_API_KEY（见 README.md）
  2. card-lister 预设与 skills 已安装，headless 默认预设指向 card-lister
     （见 README.md「与 headless 的集成」）
"""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

DEFAULT_DSH_CMD = "dsh"
DEFAULT_PROFILE = "headless"
DEFAULT_TASK_TEMPLATE = "task-prompt.md"
HEADLESS_TIMEOUT_S = 900


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_manifest(path: str) -> list[dict]:
    items: list[dict] = []
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    items.append(json.loads(line))
    return items


def save_manifest(path: str, items: list[dict]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for item in items:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")


def scan_items(customer: str) -> list[dict]:
    items: list[dict] = []
    for kind, item_type in (("singles", "single-card"), ("lots", "lot")):
        base = os.path.join(customer, kind)
        if not os.path.isdir(base):
            continue
        for name in sorted(os.listdir(base)):
            if os.path.isdir(os.path.join(base, name)):
                items.append({"item": f"{kind}/{name}", "type": item_type})
    return items


def reconcile(items: list[dict], scanned: list[dict]) -> list[dict]:
    by_item = {it["item"]: it for it in items}
    result = []
    for s in scanned:
        existing = by_item.get(s["item"])
        if existing is None:
            result.append({**s, "status": "pending", "updated_at": now_iso()})
        else:
            result.append(existing)
    return result


def out_path_for(out_dir: str, item: str) -> str:
    return os.path.join(out_dir, "items", item.replace("/", "_") + ".json")


def load_json_if_valid(path: str):
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def run_headless(cmd: str, profile: str, task: str) -> tuple[int, str]:
    try:
        proc = subprocess.run(
            [cmd, "--profile", profile, task],
            capture_output=True,
            text=True,
            timeout=HEADLESS_TIMEOUT_S,
        )
        return proc.returncode, (proc.stdout or "") + (proc.stderr or "")
    except subprocess.TimeoutExpired:
        return 1, "timeout"
    except FileNotFoundError:
        return 1, f"command not found: {cmd}"


def merge_record(result_path: str, record: dict) -> None:
    with open(result_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def export_csv(result_path: str, csv_path: str) -> None:
    columns = [
        "customerId", "itemId", "itemType", "sport", "lotId", "cardCount",
        "name", "set", "year", "number", "rarity", "parallel", "variant",
        "isCore", "confidence", "needsReview", "notes",
    ]
    rows = []
    if not os.path.exists(result_path):
        print(f"未找到结果文件 {result_path}，跳过 CSV 导出")
        return
    with open(result_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            cards = rec.get("cards") or rec.get("coreCards") or []
            for card in cards or [{}]:
                rows.append({c: rec.get(c) for c in columns if c in rec} | card)
    with open(csv_path, "w", encoding="utf-8", newline="") as f:
        import csv
        writer = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
    print(f"已导出 CSV：{csv_path}（{len(rows)} 行）")


def main() -> int:
    parser = argparse.ArgumentParser(description="card-agent 批量识别编排")
    parser.add_argument("--customer", required=True, help="客户目录（含 singles/ 与 lots/）")
    parser.add_argument("--out", required=True, help="输出目录（manifest/result/review/CSV）")
    parser.add_argument("--cmd", default=DEFAULT_DSH_CMD, help=f"dsh 命令（默认 {DEFAULT_DSH_CMD}）")
    parser.add_argument("--profile", default=DEFAULT_PROFILE, help=f"dsh profile（默认 {DEFAULT_PROFILE}）")
    parser.add_argument("--task-template", default=DEFAULT_TASK_TEMPLATE, help="任务模板路径")
    parser.add_argument("--customer-id", default="", help="写入结果的 customerId（默认取客户目录名）")
    args = parser.parse_args()

    customer = os.path.abspath(args.customer)
    out_dir = os.path.abspath(args.out)
    items_dir = os.path.join(out_dir, "items")
    os.makedirs(items_dir, exist_ok=True)

    manifest_path = os.path.join(out_dir, "manifest.jsonl")
    result_path = os.path.join(out_dir, "result.jsonl")
    review_path = os.path.join(out_dir, "review.jsonl")
    csv_path = os.path.join(out_dir, "result.csv")

    with open(args.task_template, encoding="utf-8") as f:
        template = f.read()

    items = reconcile(load_manifest(manifest_path), scan_items(customer))
    save_manifest(manifest_path, items)

    pending = [it for it in items if it["status"] in ("pending", "in-flight")]
    done_count = sum(1 for it in items if it["status"] == "done")
    print(f"共 {len(items)} 项：已完成 {done_count}，待处理 {len(pending)}")

    customer_id = args.customer_id or os.path.basename(customer.rstrip("/"))

    for item in pending:
        out_path = out_path_for(out_dir, item["item"])
        item["status"] = "in-flight"
        item["updated_at"] = now_iso()
        save_manifest(manifest_path, items)

        record = load_json_if_valid(out_path)
        if record is not None and record.get("itemType") == item["type"]:
            item["status"] = "done"
            item["updated_at"] = now_iso()
            record["itemId"] = f"{customer_id}-{os.path.basename(item['item'])}"
            merge_record(result_path, record)
            save_manifest(manifest_path, items)
            print(f"[跳过] {item['item']} 已有有效结果，标记完成")
            continue

        task = (
            template
            .replace("{item_path}", os.path.join(customer, item["item"]))
            .replace("{out_path}", out_path)
        )
        print(f"[处理] {item['item']}")
        code, output = run_headless(args.cmd, args.profile, task)

        record = load_json_if_valid(out_path)
        if code == 0 and record is not None:
            record.setdefault("customerId", customer_id)
            record["itemId"] = f"{customer_id}-{os.path.basename(item['item'])}"
            item["status"] = "done"
            merge_record(result_path, record)
            print(f"[完成] {item['item']}")
        else:
            item["status"] = "in-flight"
            with open(review_path, "a", encoding="utf-8") as f:
                f.write(json.dumps({
                    "item": item["item"],
                    "reason": "headless 失败或未产出有效 JSON",
                    "detail": output[-2000:],
                    "updated_at": now_iso(),
                }, ensure_ascii=False) + "\n")
            print(f"[失败] {item['item']}，已记入 review，下次可重试")
        item["updated_at"] = now_iso()
        save_manifest(manifest_path, items)

    export_csv(result_path, csv_path)
    remaining = sum(1 for it in items if it["status"] in ("pending", "in-flight"))
    print(f"本次结束：剩余待处理 {remaining} 项（直接重跑本命令即可断点续跑）")
    return 0 if remaining == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
