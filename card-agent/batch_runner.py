#!/usr/bin/env python3
"""批量处理编排脚本：manifest 状态机 + 断点续跑 + 可选预分类层（YOLO / GLM）。

流程：
  1. 扫描客户目录 singles/* 与 lots/* 生成待办项，登记到 manifest
  2. 逐项处理：
     a. （可选预分类）对每张图判角色，全干扰组直接标 skipped，不启动模型
     b. 正常组：填充任务模板 -> 调 dsh headless -> 结果写 items/<key>.json
     c. 合并 result.jsonl，更新 manifest 状态
  3. 汇总导出 result.csv

状态机：pending -> in-flight -> done；全干扰组 -> skipped。
"""
from __future__ import annotations

import argparse
import base64
import csv
import json
import mimetypes
import os
import shutil
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROLES = {
    "single_front",
    "single_back",
    "lot_group",
    "lot_label",
    "core_front",
    "core_back",
    "unrelated",
}
IMG_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_json_if_valid(path: Path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def merge_record(result_path: Path, record: dict) -> None:
    result_path.parent.mkdir(parents=True, exist_ok=True)
    with open(result_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def scan_items(customer_dir: Path) -> list[dict]:
    items: list[dict] = []
    for sub in ("singles", "lots"):
        base = customer_dir / sub
        if not base.is_dir():
            continue
        for child in sorted(base.iterdir()):
            if child.is_dir():
                items.append({"item": str(child.relative_to(customer_dir)), "type": "single-card" if sub == "singles" else "lot"})
            elif child.is_file() and child.suffix.lower() in IMG_EXTS:
                items.append({"item": str(child.relative_to(customer_dir)), "type": "single-card" if sub == "singles" else "lot"})
    return items


def reconcile(manifest_path: Path, items: list[dict]) -> list[dict]:
    manifest: list[dict] = []
    if manifest_path.exists():
        for line in manifest_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                try:
                    manifest.append(json.loads(line))
                except ValueError:
                    continue
    by_item = {m["item"]: m for m in manifest}
    for it in items:
        if it["item"] not in by_item:
            by_item[it["item"]] = {
                "item": it["item"],
                "type": it["type"],
                "status": "pending",
                "updated_at": now_iso(),
            }
    ordered = [by_item[it["item"]] for it in items]
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with open(manifest_path, "w", encoding="utf-8") as f:
        for m in ordered:
            f.write(json.dumps(m, ensure_ascii=False) + "\n")
    return ordered


def save_manifest(manifest_path: Path, manifest: list[dict]) -> None:
    with open(manifest_path, "w", encoding="utf-8") as f:
        for m in manifest:
            f.write(json.dumps(m, ensure_ascii=False) + "\n")


def image_files(item_dir: Path) -> list[Path]:
    if item_dir.is_dir():
        files = [p for p in sorted(item_dir.iterdir()) if p.suffix.lower() in IMG_EXTS]
    else:
        files = [item_dir] if item_dir.suffix.lower() in IMG_EXTS else []
    return files


def classify_yolo(images: list[Path], model_path: str, conf: float) -> dict[str, str]:
    """用 YOLO 分类模型对每张图判角色。类名与 ROLES 对齐；不在集合内视为 unrelated。"""
    from ultralytics import YOLO  # 延迟导入，未安装时仅在使用 yolo 模式报错

    model = YOLO(model_path)
    result: dict[str, str] = {}
    for img in images:
        try:
            res = model.predict(str(img), conf=conf, verbose=False)[0]
            top = res.probs.top1
            name = res.names[top]
            result[img.name] = name if name in ROLES else "unrelated"
        except Exception:
            result[img.name] = "unrelated"
    return result


def classify_glm(images: list[Path], api_key: str, endpoint: str, model: str) -> dict[str, str]:
    """用 GLM 视觉模型（OpenAI 兼容 /chat/completions）对每张图判角色。"""
    labels = ", ".join(sorted(ROLES))
    result: dict[str, str] = {}
    for img in images:
        mime = mimetypes.guess_type(img.name)[0] or "image/jpeg"
        b64 = base64.b64encode(img.read_bytes()).decode()
        payload = {
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": f"判断这张图片属于以下哪种角色：{labels}。只输出一个类别名，不要解释。"},
                        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
                    ],
                }
            ],
            "max_tokens": 16,
        }
        req = urllib.request.Request(
            endpoint,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode())
            label = data["choices"][0]["message"]["content"].strip().lower()
            result[img.name] = label if label in ROLES else "unrelated"
        except Exception:
            result[img.name] = "unrelated"
    return result


def preclassify(item_dir: Path, mode: str, args) -> dict[str, str] | None:
    images = image_files(item_dir)
    if not images or mode == "none":
        return None
    if mode == "yolo":
        return classify_yolo(images, args.yolo_model, args.yolo_conf)
    if mode == "glm":
        return classify_glm(images, args.glm_api_key, args.glm_endpoint, args.glm_model)
    return None


def write_roles_hint(out_dir: Path, key: str, roles: dict[str, str]) -> Path:
    path = out_dir / "roles" / f"{key}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(roles, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def build_prompt(template: str, item_dir: Path, out_path: Path, roles: dict[str, str] | None, customer_id: str) -> str:
    prompt = (
        template.replace("{item_path}", str(item_dir))
        .replace("{out_path}", str(out_path))
        .replace("{customer_id}", customer_id)
    )
    if roles:
        hint = (
            "\n\n===== 预分类结果（来自 YOLO/GLM，仅供参考，请复核） =====\n"
            + json.dumps(roles, ensure_ascii=False)
            + "\n角色含义：single_front=单卡正面 single_back=单卡反面 lot_group=lot合照 "
            "lot_label=包装袋编号图 core_front=核心卖点正面 core_back=核心卖点反面 unrelated=干扰图。\n"
            "被标记为 unrelated 的图片请跳过，不要从其中提取任何信息。"
        )
        prompt += hint
    return prompt


def run_headless(cmd: str, prompt: str, cwd: Path, timeout: int) -> tuple[int, str]:
    argv = cmd.split() + ["--profile", "headless", prompt]
    try:
        proc = subprocess.run(argv, cwd=str(cwd), capture_output=True, text=True, timeout=timeout)
        return proc.returncode, proc.stdout + proc.stderr
    except FileNotFoundError:
        return 127, f"dsh 命令不存在：{cmd}"
    except subprocess.TimeoutExpired:
        return 124, "超时"


def export_csv(result_path: Path, csv_path: Path) -> None:
    if not result_path.exists():
        return
    with open(result_path, encoding="utf-8") as rf:
        records = [json.loads(line) for line in rf if line.strip()]
    rows = []
    for rec in records:
        cards = rec.get("cards") or [{}]
        for c in cards:
            rows.append(
                {
                    "customerId": rec.get("customerId", ""),
                    "itemId": rec.get("itemId", ""),
                    "itemType": rec.get("itemType", ""),
                    "sport": rec.get("sport", ""),
                    "name": c.get("name", ""),
                    "set": c.get("set", ""),
                    "year": c.get("year", ""),
                    "number": c.get("number", ""),
                    "isCore": c.get("isCore", ""),
                    "conditionNote": c.get("conditionNote", ""),
                    "confidence": rec.get("confidence", ""),
                    "needsReview": rec.get("needsReview", ""),
                    "notes": rec.get("notes", ""),
                }
            )
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as cf:
        writer = csv.DictWriter(cf, fieldnames=list(rows[0].keys()) if rows else [])
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description="球星卡批量识别编排脚本")
    parser.add_argument("--customer", required=True, help="客户图片目录（含 singles/ 与 lots/）")
    parser.add_argument("--out", required=True, help="输出目录")
    parser.add_argument("--cmd", default="dsh", help="dsh 命令（默认 dsh）")
    parser.add_argument("--customer-id", default="", help="客户 ID（默认取目录名）")
    parser.add_argument("--template", default="", help="任务模板文件路径（默认用内置模板）")
    parser.add_argument("--timeout", type=int, default=900, help="单次 headless 超时秒数（默认 900）")
    parser.add_argument("--preclassify", choices=["none", "yolo", "glm"], default="none", help="预分类方式（默认 none）")
    parser.add_argument("--yolo-model", default="", help="YOLO 分类权重路径（--preclassify yolo 时必填）")
    parser.add_argument("--yolo-conf", type=float, default=0.5, help="YOLO 置信度阈值（默认 0.5）")
    parser.add_argument("--glm-api-key", default="", help="GLM API Key（--preclassify glm 时必填）")
    parser.add_argument("--glm-endpoint", default="https://open.bigmodel.cn/api/paas/v4/chat/completions", help="GLM OpenAI 兼容端点")
    parser.add_argument("--glm-model", default="glm-4v-flash", help="GLM 视觉模型名（默认 glm-4v-flash）")
    args = parser.parse_args()

    if args.preclassify == "yolo" and not args.yolo_model:
        parser.error("--preclassify yolo 需要 --yolo-model")
    if args.preclassify == "glm" and not args.glm_api_key:
        parser.error("--preclassify glm 需要 --glm-api-key")

    customer_dir = Path(args.customer).resolve()
    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    customer_id = args.customer_id or customer_dir.name

    manifest_path = out_dir / "manifest.jsonl"
    result_path = out_dir / "result.jsonl"
    review_path = out_dir / "review.jsonl"

    template_path = Path(args.template) if args.template else Path(__file__).parent / "task-prompt.md"
    template = template_path.read_text(encoding="utf-8")

    items = scan_items(customer_dir)
    manifest = reconcile(manifest_path, items)

    pending = [m for m in manifest if m["status"] in ("pending", "in-flight")]
    print(f"待处理 {len(pending)} 项（共 {len(manifest)} 项）", flush=True)

    for m in pending:
        item_rel = m["item"]
        item_dir = customer_dir / item_rel
        key = item_rel.replace(os.sep, "__").replace("/", "__")
        out_path = out_dir / "items" / f"{key}.json"

        print(f"[{m['status']}->in-flight] {item_rel}", flush=True)
        m["status"] = "in-flight"
        m["updated_at"] = now_iso()
        save_manifest(manifest_path, manifest)

        record = load_json_if_valid(out_path)
        if record is not None and record.get("itemType") == m["type"]:
            m["status"] = "done"
            m["updated_at"] = now_iso()
            record["itemId"] = f"{customer_id}-{os.path.basename(item_rel)}"
            merge_record(result_path, record)
            print(f"  已有有效结果，直接完成", flush=True)
            continue

        roles = preclassify(item_dir, args.preclassify, args)
        if roles is not None:
            write_roles_hint(out_dir, key, roles)
            non_interference = [r for r in roles.values() if r != "unrelated"]
            if not non_interference:
                m["status"] = "skipped"
                m["updated_at"] = now_iso()
                print(f"  预分类判定为全干扰图，标记 skipped（省一次模型调用）", flush=True)
                continue

        prompt = build_prompt(template, item_dir, out_path, roles, customer_id)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        code, output = run_headless(args.cmd, prompt, customer_dir, args.timeout)

        record = load_json_if_valid(out_path)
        if code == 0 and record is not None and record.get("itemType") == m["type"]:
            record["itemId"] = f"{customer_id}-{os.path.basename(item_rel)}"
            merge_record(result_path, record)
            m["status"] = "done"
            m["updated_at"] = now_iso()
            print(f"  完成 -> {record.get('itemId')}", flush=True)
        else:
            merge_record(
                review_path,
                {"item": item_rel, "type": m["type"], "reason": "识别失败", "code": code, "detail": output[-2000:], "time": now_iso()},
            )
            m["status"] = "in-flight"
            m["updated_at"] = now_iso()
            print(f"  失败（code={code}），已记入 review.jsonl，留待重试", flush=True)

        save_manifest(manifest_path, manifest)

    export_csv(result_path, out_dir / "result.csv")

    done = sum(1 for x in manifest if x["status"] == "done")
    skipped = sum(1 for x in manifest if x["status"] == "skipped")
    inflight = sum(1 for x in manifest if x["status"] == "in-flight")
    print(f"\n汇总：done={done} skipped={skipped} in-flight={inflight} 总={len(manifest)}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
