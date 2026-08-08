"""Merge API batch results into the remote Infinite Canvas document."""

from __future__ import annotations

import uuid

from .progress_store import clean_text


def element_image_url(element: dict) -> str:
    if element.get("type") in {"image", "drawing"}:
        return clean_text(element.get("src"))
    if element.get("type") == "imageGenerator":
        return clean_text(element.get("generatedImageSrc"))
    return ""


def generator_display_size(aspect_ratio: str) -> tuple[float, float]:
    try:
        width_ratio, height_ratio = map(float, aspect_ratio.split(":", 1))
        ratio = width_ratio / height_ratio
    except (ValueError, ZeroDivisionError):
        return 320, 320
    return (320, 320 / ratio) if ratio > 1 else (320 * ratio, 320)


def save_canvas_nodes(auth, project_id: str, records: list[dict]) -> dict:
    if not records:
        return {"nodes": 0, "edges": 0}
    _, project = auth.request("GET", f"/projects/{project_id}")
    canvas = dict(project.get("data") or {})
    elements = list(canvas.get("elements") or [])
    edges = list(canvas.get("edges") or [])
    root_order = list(canvas.get("rootOrder") or [])
    if not root_order and elements:
        root_order = [
            element["id"]
            for element in sorted(elements, key=lambda item: item.get("zIndex", 0), reverse=True)
        ]
    reference_node_ids = {}
    result_node_ids = {}
    for element in elements:
        image_url = element_image_url(element)
        if image_url:
            reference_node_ids.setdefault(image_url, element["id"])
        if element.get("type") == "imageGenerator" and image_url:
            result_node_ids.setdefault(image_url, element["id"])
    edge_pairs = {(edge.get("sourceNodeId"), edge.get("targetNodeId")) for edge in edges}
    existing_right = max(
        (
            element.get("position", {}).get("x", 0) + element.get("width", 0) / 2
            for element in elements
        ),
        default=-400,
    )
    base_x = existing_right + 400 if elements else 0
    base_y = min((element.get("position", {}).get("y", 0) for element in elements), default=0)
    next_z = max((element.get("zIndex", 0) for element in elements), default=0) + 1
    new_node_ids = []
    new_edge_count = 0
    reference_urls = list(dict.fromkeys(url for record in records for url in record["references"]))
    for reference_index, image_url in enumerate(reference_urls, start=1):
        if image_url in reference_node_ids:
            continue
        node_id = "batch-ref-" + uuid.uuid4().hex
        elements.append(
            {
                "id": node_id,
                "type": "image",
                "name": f"Batch 引用 {reference_index}",
                "position": {"x": base_x, "y": base_y + (reference_index - 1) * 360},
                "width": 300,
                "height": 300,
                "rotation": 0,
                "zIndex": next_z,
                "src": image_url,
            }
        )
        next_z += 1
        new_node_ids.append(node_id)
        reference_node_ids[image_url] = node_id
    for row, record in enumerate(sorted(records, key=lambda item: item["index"])):
        for image_index, image_url in enumerate(record["images"], start=1):
            node_id = result_node_ids.get(image_url)
            if not node_id:
                node_id = "batch-result-" + uuid.uuid4().hex
                width, height = generator_display_size(record["aspect_ratio"])
                settings = {
                    "aspectRatio": record["aspect_ratio"],
                    "imageSize": record["image_size"],
                    "modelId": record["model_id"],
                }
                elements.append(
                    {
                        "id": node_id,
                        "type": "imageGenerator",
                        "name": f"Batch 结果 {record['index']:03d}-{image_index:02d}",
                        "position": {
                            "x": base_x + 520 + (image_index - 1) * 380,
                            "y": base_y + row * 380,
                        },
                        "width": width,
                        "height": height,
                        "rotation": 0,
                        "zIndex": next_z,
                        "prompt": record["prompt"],
                        "generatedImageSrc": image_url,
                        "aspectRatio": record["aspect_ratio"],
                        "imageSize": record["image_size"],
                        "modelId": record["model_id"],
                        "isGenerating": False,
                        "generatedImageSettings": settings,
                    }
                )
                next_z += 1
                new_node_ids.append(node_id)
                result_node_ids[image_url] = node_id
            for reference_url in record["references"]:
                edge_pair = (reference_node_ids[reference_url], node_id)
                if edge_pair in edge_pairs:
                    continue
                edges.append(
                    {
                        "id": "batch-edge-" + uuid.uuid4().hex,
                        "sourceNodeId": edge_pair[0],
                        "targetNodeId": node_id,
                        "sourcePortKey": "output",
                        "targetPortKey": "input_0",
                        "sourceImageSnapshotUrl": reference_url,
                    }
                )
                edge_pairs.add(edge_pair)
                new_edge_count += 1
    try:
        migration_version = max(int(canvas.get("migrationVersion") or 0), 4)
    except (TypeError, ValueError):
        migration_version = 4
    canvas.update(
        {
            "elements": elements,
            "rootOrder": new_node_ids + [item for item in root_order if item not in new_node_ids],
            "groupMeta": canvas.get("groupMeta") or {},
            "edges": edges,
            "migrationVersion": migration_version,
            "analysisResults": canvas.get("analysisResults") or {},
        }
    )
    auth.request("PUT", f"/projects/{project_id}", {"data": canvas})
    return {"nodes": len(new_node_ids), "edges": new_edge_count}
