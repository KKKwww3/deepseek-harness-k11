"""可扩展的预分类层：YOLO 本地模型 / VLM（OpenAI 兼容端点，支持一次多图批量）。

设计：
  - 每个预分类器是一个 BaseClassifier 子类，实现统一的 classify(images) -> dict[str, str]
  - REGISTRY 注册表 + create() 工厂，新增一种 VLM/检测器只加一个类，不改主流程
  - 输出角色名严格限定在 ROLES 集合内，不识别卡片内容
"""
from __future__ import annotations

import base64
import json
import mimetypes
import re
import urllib.request
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


def _b64_data_url(img: Path) -> str:
    mime = mimetypes.guess_type(img.name)[0] or "image/jpeg"
    b64 = base64.b64encode(img.read_bytes()).decode()
    return f"data:{mime};base64,{b64}"


def _chunks(items: list, size: int):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def _extract_json_map(text: str) -> dict | None:
    """尽力从模型返回文本里解析出 {文件名: 角色} 映射。"""
    text = text.strip()
    # 直接 JSON
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except ValueError:
        pass
    # 从围栏代码块里提取
    m = re.search(r"\{[\s\S]*\}", text)
    if m:
        try:
            obj = json.loads(m.group(0))
            if isinstance(obj, dict):
                return obj
        except ValueError:
            pass
    # 兜底：逐个 key: value
    pairs = re.findall(r'"([^"]+)":\s*"([^"]+)"', text)
    if pairs:
        return {k: v for k, v in pairs}
    return None


class BaseClassifier:
    name = "base"

    def __init__(self, args) -> None:
        self.args = args

    def classify(self, images: list[Path]) -> dict[str, str]:
        raise NotImplementedError


class YoloClassifier(BaseClassifier):
    """YOLO 本地图像分类模型。类名与 ROLES 对齐，不在集合内视为 unrelated。"""

    name = "yolo"

    def __init__(self, args) -> None:
        super().__init__(args)
        from ultralytics import YOLO  # 延迟导入，仅在使用 yolo 模式时依赖

        self.model = YOLO(args.yolo_model)
        self.conf = args.yolo_conf

    def classify(self, images: list[Path]) -> dict[str, str]:
        result: dict[str, str] = {}
        for img in images:
            try:
                res = self.model.predict(str(img), conf=self.conf, verbose=False)[0]
                name = res.names[res.probs.top1]
                result[img.name] = name if name in ROLES else "unrelated"
            except Exception:
                result[img.name] = "unrelated"
        return result


class VlmClassifier(BaseClassifier):
    """VLM 预分类器（OpenAI 兼容 /chat/completions）。

    一次请求携带 batch_size 张图片（多 image_url），要求模型返回
    {文件名: 角色} 的 JSON 映射，从而一次批量判定大量图片。仅判角色，
    不识别卡片内容。
    """

    name = "vlm"

    def __init__(self, args) -> None:
        super().__init__(args)
        self.endpoint = args.vlm_endpoint
        self.model = args.vlm_model
        self.api_key = args.vlm_api_key
        self.timeout = args.vlm_timeout
        self.batch_size = max(1, args.vlm_batch_size)

    def classify(self, images: list[Path]) -> dict[str, str]:
        result: dict[str, str] = {img.name: "unrelated" for img in images}
        labels = ", ".join(sorted(ROLES))
        for batch in _chunks(images, self.batch_size):
            files = [img.name for img in batch]
            max_tokens = max(256, len(batch) * 96)
            content: list[dict] = [
                {
                    "type": "text",
                    "text": (
                        f"下面依次给出 {len(batch)} 张图片，顺序对应文件名列表：{', '.join(files)}。\n"
                        f"请判断每张图片属于以下哪种角色：{labels}。\n"
                        f"只输出一个 JSON 对象，键为文件名，值为角色名，"
                        f'例如：{{"{files[0]}": "single_front", ...}}。不要输出任何其他内容。'
                    ),
                }
            ]
            for img in batch:
                content.append({"type": "image_url", "image_url": {"url": _b64_data_url(img)}})
            payload = {
                "model": self.model,
                "messages": [{"role": "user", "content": content}],
                "max_tokens": max_tokens,
            }
            req = urllib.request.Request(
                self.endpoint,
                data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.api_key}"},
            )
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    data = json.loads(resp.read().decode())
                text = data["choices"][0]["message"]["content"]
                mapping = _extract_json_map(text)
                if mapping:
                    for fname in files:
                        label = str(mapping.get(fname, "")).strip().lower()
                        result[fname] = label if label in ROLES else "unrelated"
            except Exception:
                # 整批失败：维持 unrelated 兜底
                pass
        return result


REGISTRY: dict[str, type[BaseClassifier]] = {
    YoloClassifier.name: YoloClassifier,
    VlmClassifier.name: VlmClassifier,
}


def create(mode: str, args) -> BaseClassifier | None:
    """按模式名创建预分类器；none 或未知模式返回 None。"""
    if mode == "none":
        return None
    cls = REGISTRY.get(mode)
    if cls is None:
        return None
    return cls(args)
