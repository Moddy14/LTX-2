"""Offline InsightFace-106 alignment for MuseTalk 1.5 on DGX ARM64."""

from __future__ import annotations

import os

import cv2
from insightface.app import FaceAnalysis
import numpy as np
from tqdm import tqdm


coord_placeholder = (0.0, 0.0, 0.0, 0.0)
LMK_ADAPT_ORIGIN_ORDER = [
    1, 10, 12, 14, 16, 3, 5, 7, 0, 23, 21, 19, 32, 30, 28, 26, 17,
    43, 48, 49, 51, 50, 102, 103, 104, 105, 101, 73, 74, 86,
]


def _build_face_analyser() -> FaceAnalysis:
    root = os.environ.get("MUSETALK_INSIGHTFACE_ROOT", "/models/insightface")
    app = FaceAnalysis(
        name="buffalo_l",
        allowed_modules=["detection", "landmark_2d_106"],
        root=root,
        providers=["CPUExecutionProvider"],
    )
    app.prepare(ctx_id=-1, det_size=(512, 512))
    return app


face_analyser = _build_face_analyser()


def read_imgs(img_list):
    frames = []
    print("reading images...", flush=True)
    for img_path in tqdm(img_list):
        frame = cv2.imread(img_path)
        if frame is None:
            raise RuntimeError(f"Unreadable MuseTalk frame: {img_path}")
        frames.append(frame)
    return frames


def _largest_face(frame: np.ndarray):
    selected = None
    selected_area = 0.0
    for face in face_analyser.get(frame):
        x1, y1, x2, y2 = face.bbox.tolist()
        area = max(0.0, x2 - x1) * max(0.0, y2 - y1)
        if face.det_score >= 0.5 and area > selected_area:
            selected = face
            selected_area = area
    return selected


def _musetalk_bbox(frame: np.ndarray, upperbondrange: int):
    face = _largest_face(frame)
    if face is None:
        return coord_placeholder

    height, width = frame.shape[:2]
    landmarks = np.round(face.landmark_2d_106).astype(np.int_)
    sub_landmarks = landmarks[LMK_ADAPT_ORIGIN_ORDER]
    half_face_coordinate = np.mean([landmarks[74], landmarks[73]], axis=0)
    half_face_coordinate[1] += upperbondrange
    half_face_distance = np.max(sub_landmarks[:, 1]) - half_face_coordinate[1]
    candidate = (
        int(np.min(sub_landmarks[:, 0])),
        int(max(0, half_face_coordinate[1] - half_face_distance)),
        int(np.max(sub_landmarks[:, 0])),
        int(np.max(sub_landmarks[:, 1])),
    )
    x1, y1, x2, y2 = candidate
    if y2 <= y1 or x2 <= x1 or x1 < 0:
        x1, y1, x2, y2 = np.round(face.bbox).astype(np.int_).tolist()
    return (
        max(0, x1),
        max(0, y1),
        min(width, x2),
        min(height, y2),
    )


def get_landmark_and_bbox(img_list, upperbondrange=0):
    frames = read_imgs(img_list)
    coordinates = [
        _musetalk_bbox(frame, int(upperbondrange))
        for frame in tqdm(frames, desc="InsightFace-106 alignment")
    ]
    missing = sum(coordinate == coord_placeholder for coordinate in coordinates)
    if missing:
        first_usable = next(
            (coordinate for coordinate in coordinates if coordinate != coord_placeholder),
            None,
        )
        if first_usable is None:
            raise RuntimeError("InsightFace could not align a face in any input frame.")
        previous = first_usable
        for index, coordinate in enumerate(coordinates):
            if coordinate == coord_placeholder:
                coordinates[index] = previous
            else:
                previous = coordinate
        print(
            f"InsightFace reused the nearest stable box for {missing}/{len(coordinates)} frames.",
            flush=True,
        )
    return coordinates, frames


def get_bbox_range(img_list, upperbondrange=0):
    coordinates, _ = get_landmark_and_bbox(img_list, upperbondrange)
    usable = len(coordinates) - sum(coordinate == coord_placeholder for coordinate in coordinates)
    return f"Total frames: {len(coordinates)}; usable InsightFace-106 boxes: {usable}"


def resize_landmark(landmark, w, h, new_w, new_h):
    landmark = np.asarray(landmark)
    return landmark / [w, h] * [new_w, new_h]
