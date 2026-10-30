from __future__ import annotations

import json
import math
import io
import os
import zipfile
from typing import Any
from urllib.parse import quote

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from PIL import Image


app = FastAPI(title="GeoAlign Refine Service")
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1):\d+$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/refine")
async def refine(image: UploadFile = File(...), payload: str = Form(...)) -> dict[str, Any]:
    try:
      data = json.loads(payload)
    except json.JSONDecodeError as exc:
      raise HTTPException(status_code=400, detail=f"payload JSON 解析失败: {exc}") from exc

    try:
        image_bytes = await image.read()
        source_image = load_image(image_bytes)
        initial = data["transform"]
        initial_matrix = affine_to_matrix(initial)
        inverse_initial = invert_affine(initial_matrix)
        scale = choose_scale(source_image.shape[1], source_image.shape[0])

        image_edges = build_image_edges(source_image, scale)
        geo_mask = build_geo_mask(
            data.get("segments", []),
            inverse_initial,
            source_image.shape[1],
            source_image.shape[0],
            scale,
        )

        if np.count_nonzero(geo_mask) < 32:
            raise ValueError("GeoJSON 线稿太少，无法自动精修。")
        if np.count_nonzero(image_edges) < 32:
            raise ValueError("图片边缘太少，无法自动精修。")

        delta_small, correlation = run_ecc(geo_mask, image_edges)
        delta_full = scale_delta_to_full(delta_small, scale)
        refined_matrix = compose_affine(initial_matrix, delta_full)

        return {
            "transform": matrix_to_affine(refined_matrix),
            "delta": matrix_to_affine(delta_full),
            "correlation": float(correlation),
            "scale": float(scale),
            "message": "自动精修完成",
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/export")
async def export_alignment(image: UploadFile = File(...), payload: str = Form(...)) -> StreamingResponse:
    try:
        data = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"payload JSON 解析失败: {exc}") from exc

    try:
        image_bytes = await image.read()
        image_name = safe_filename(image.filename or "image.jpg")
        stem, ext = os.path.splitext(image_name)
        if not stem:
            stem = "image"
        if not ext:
            ext = ".jpg"
            image_name = f"{stem}{ext}"

        transform = data["transform"]
        package = io.BytesIO()
        with zipfile.ZipFile(package, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(image_name, image_bytes, compress_type=zipfile.ZIP_STORED)
            zf.writestr(
                f"{stem}.geoalign.json",
                json.dumps(build_geoalign_json(data, image_name), ensure_ascii=False, indent=2),
            )
            zf.writestr(f"{stem}{worldfile_extension(ext)}", build_world_file(transform))
            zf.writestr(
                f"{stem}.segments.geojson",
                json.dumps(build_segments_geojson(data.get("segments", [])), ensure_ascii=False),
            )
            zf.writestr(
                "README.txt",
                "This package keeps the original image and stores georeferencing separately.\n"
                "Use the .geoalign.json file in web/canvas apps.\n"
                "The world file is included for simple affine GIS workflows.\n",
            )
        package.seek(0)

        headers = {"Content-Disposition": build_content_disposition(f"{stem}-geoalign.zip")}
        return StreamingResponse(package, media_type="application/zip", headers=headers)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def load_image(image_bytes: bytes) -> np.ndarray:
    with Image.open(io.BytesIO(image_bytes)) as img:
        rgb = img.convert("RGB")
        return cv2.cvtColor(np.array(rgb), cv2.COLOR_RGB2BGR)


def choose_scale(width: int, height: int, max_side: int = 1600) -> float:
    return min(1.0, max_side / max(width, height))


def build_image_edges(image: np.ndarray, scale: float) -> np.ndarray:
    if scale != 1.0:
        image = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    edges = cv2.Canny(gray, 40, 120)
    edges = cv2.dilate(edges, np.ones((2, 2), dtype=np.uint8), iterations=1)
    return (edges.astype(np.float32) / 255.0)


def build_geo_mask(
    segments: list[dict[str, Any]],
    world_to_image: np.ndarray,
    width: int,
    height: int,
    scale: float,
) -> np.ndarray:
    mask = np.zeros((max(1, int(round(height * scale))), max(1, int(round(width * scale)))), dtype=np.uint8)
    for segment in segments:
        rings = segment.get("rings") or []
        segment_type = segment.get("type")
        for ring in rings:
            points = []
            for item in ring:
                image_point = apply_matrix(world_to_image, float(item["x"]), float(item["y"]))
                points.append([int(round(image_point[0] * scale)), int(round(image_point[1] * scale))])
            if not points:
                continue
            pts = np.array(points, dtype=np.int32)
            if segment_type == "Point":
                cv2.circle(mask, tuple(pts[0]), 4, 255, -1)
            else:
                cv2.polylines(mask, [pts], isClosed=segment_type == "Polygon", color=255, thickness=2, lineType=cv2.LINE_AA)
    mask = cv2.dilate(mask, np.ones((2, 2), dtype=np.uint8), iterations=1)
    mask = cv2.GaussianBlur(mask, (3, 3), 0)
    return mask.astype(np.float32) / 255.0


def run_ecc(template: np.ndarray, moving: np.ndarray) -> tuple[np.ndarray, float]:
    warp = np.eye(2, 3, dtype=np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 120, 1e-6)
    try:
        correlation, matrix = cv2.findTransformECC(
            template,
            moving,
            warp,
            cv2.MOTION_AFFINE,
            criteria,
            None,
            5,
        )
    except cv2.error as exc:
        raise ValueError(f"ECC 未收敛: {exc}") from exc
    if not np.isfinite(correlation):
        raise ValueError("ECC 返回了无效相关系数。")
    return matrix.astype(np.float64), float(correlation)


def affine_to_matrix(transform: dict[str, float]) -> np.ndarray:
    return np.array(
        [
            [float(transform["a"]), float(transform["b"]), float(transform["c"])],
            [float(transform["d"]), float(transform["e"]), float(transform["f"])],
        ],
        dtype=np.float64,
    )


def matrix_to_affine(matrix: np.ndarray) -> dict[str, float]:
    return {
        "a": float(matrix[0, 0]),
        "b": float(matrix[0, 1]),
        "c": float(matrix[0, 2]),
        "d": float(matrix[1, 0]),
        "e": float(matrix[1, 1]),
        "f": float(matrix[1, 2]),
    }


def invert_affine(matrix: np.ndarray) -> np.ndarray:
    full = np.array([[matrix[0, 0], matrix[0, 1], matrix[0, 2]], [matrix[1, 0], matrix[1, 1], matrix[1, 2]], [0, 0, 1]], dtype=np.float64)
    inverse = np.linalg.inv(full)
    return inverse[:2, :]


def compose_affine(first: np.ndarray, second: np.ndarray) -> np.ndarray:
    first3 = np.array([[first[0, 0], first[0, 1], first[0, 2]], [first[1, 0], first[1, 1], first[1, 2]], [0, 0, 1]], dtype=np.float64)
    second3 = np.array([[second[0, 0], second[0, 1], second[0, 2]], [second[1, 0], second[1, 1], second[1, 2]], [0, 0, 1]], dtype=np.float64)
    return (first3 @ second3)[:2, :]


def scale_delta_to_full(delta: np.ndarray, scale: float) -> np.ndarray:
    if scale <= 0 or math.isclose(scale, 1.0):
        return delta
    return np.array(
        [
            [delta[0, 0], delta[0, 1], delta[0, 2] / scale],
            [delta[1, 0], delta[1, 1], delta[1, 2] / scale],
        ],
        dtype=np.float64,
    )


def apply_matrix(matrix: np.ndarray, x: float, y: float) -> tuple[float, float]:
    return (
        matrix[0, 0] * x + matrix[0, 1] * y + matrix[0, 2],
        matrix[1, 0] * x + matrix[1, 1] * y + matrix[1, 2],
    )


def build_geoalign_json(data: dict[str, Any], image_name: str) -> dict[str, Any]:
    transform = data["transform"]
    segments = data.get("segments", [])
    return {
        "version": 1,
        "image": image_name,
        "crs": data.get("crs") or "unknown",
        "imageWidth": data.get("imageWidth"),
        "imageHeight": data.get("imageHeight"),
        "transform": transform,
        "worldFile": {
            "A": float(transform["a"]),
            "D": float(transform["d"]),
            "B": float(transform["b"]),
            "E": float(transform["e"]),
            "C": float(transform["a"]) * 0.5 + float(transform["b"]) * 0.5 + float(transform["c"]),
            "F": float(transform["d"]) * 0.5 + float(transform["e"]) * 0.5 + float(transform["f"]),
        },
        "controlPoints": data.get("controlPoints", []),
        "segments": segments,
        "segmentsCount": len(segments),
        "segmentsFile": f"{os.path.splitext(image_name)[0]}.segments.geojson",
        "note": "transform maps image pixel coordinates x/y to map coordinates. worldFile C/F use the center of the upper-left pixel.",
    }


def build_segments_geojson(segments: list[dict[str, Any]]) -> dict[str, Any]:
    features = []
    for segment in segments:
        rings = segment.get("rings") or []
        if not rings:
            continue
        segment_type = segment.get("type")
        if segment_type == "Point":
            coordinates = [rings[0][0]["x"], rings[0][0]["y"]]
            geometry = {"type": "Point", "coordinates": coordinates}
        elif segment_type == "Polygon":
            geometry = {
                "type": "Polygon",
                "coordinates": [[[point["x"], point["y"]] for point in ring] for ring in rings],
            }
        else:
            geometry = {
                "type": "LineString",
                "coordinates": [[point["x"], point["y"]] for point in rings[0]],
            }
        features.append({"type": "Feature", "properties": {"id": segment.get("id")}, "geometry": geometry})
    return {"type": "FeatureCollection", "features": features}


def build_world_file(transform: dict[str, float]) -> str:
    a = float(transform["a"])
    d = float(transform["d"])
    b = float(transform["b"])
    e = float(transform["e"])
    c = a * 0.5 + b * 0.5 + float(transform["c"])
    f = d * 0.5 + e * 0.5 + float(transform["f"])
    return "\n".join(format(value, ".12f") for value in [a, d, b, e, c, f]) + "\n"


def worldfile_extension(image_extension: str) -> str:
    ext = image_extension.lower()
    if ext in [".jpg", ".jpeg"]:
        return ".jgw"
    if ext == ".png":
        return ".pgw"
    if ext in [".tif", ".tiff"]:
        return ".tfw"
    return ".wld"


def safe_filename(filename: str) -> str:
    return "".join(char for char in filename if char not in '/\\:*?"<>|').strip() or "image.jpg"


def build_content_disposition(filename: str) -> str:
    encoded = quote(filename, safe="")
    return f"attachment; filename*=UTF-8''{encoded}"
