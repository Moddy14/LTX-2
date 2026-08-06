"""Offline InsightFace detector matching LatentSync's official alignment."""

from __future__ import annotations

import os

from insightface.app import FaceAnalysis
import numpy as np


INSIGHTFACE_DETECT_SIZE = 512
LMK_ADAPT_ORIGIN_ORDER = [
    1, 10, 12, 14, 16, 3, 5, 7, 0, 23, 21, 19, 32, 30, 28, 26, 17,
    43, 48, 49, 51, 50, 102, 103, 104, 105, 101, 73, 74, 86,
]


class FaceDetector:
    def __init__(self, device: str = "cuda"):
        del device
        root = os.environ.get("LATENTSYNC_INSIGHTFACE_ROOT", "/models/insightface")
        self.app = FaceAnalysis(
            name="buffalo_l",
            allowed_modules=["detection", "landmark_2d_106"],
            root=root,
            providers=["CPUExecutionProvider"],
        )
        self.app.prepare(ctx_id=-1, det_size=(INSIGHTFACE_DETECT_SIZE, INSIGHTFACE_DETECT_SIZE))

    def __call__(self, frame: np.ndarray, threshold: float = 0.5):
        frame_height, frame_width, _ = frame.shape
        selected = None
        max_size = 0
        for face in self.app.get(frame):
            x1, y1, x2, y2 = face.bbox.astype(np.int_).tolist()
            width, height = x2 - x1, y2 - y1
            if width < 50 or height < 80 or not 0.2 <= width / height <= 1.5:
                continue
            if face.det_score < threshold or width * height <= max_size:
                continue
            max_size = width * height
            selected = face
        if selected is None:
            return None, None

        landmarks = np.round(selected.landmark_2d_106).astype(np.int_)
        half_face_coordinate = np.mean([landmarks[74], landmarks[73]], axis=0)
        sub_landmarks = landmarks[LMK_ADAPT_ORIGIN_ORDER]
        half_face_distance = np.max(sub_landmarks[:, 1]) - half_face_coordinate[1]
        upper_bound = half_face_coordinate[1] - half_face_distance
        x1 = int(np.min(sub_landmarks[:, 0]))
        y1 = int(upper_bound)
        x2 = int(np.max(sub_landmarks[:, 0]))
        y2 = int(np.max(sub_landmarks[:, 1]))
        if y2 <= y1 or x2 <= x1 or x1 < 0:
            x1, y1, x2, y2 = selected.bbox.astype(np.int_).tolist()
        y2 += int((x2 - x1) * 0.1)
        x1 -= int((x2 - x1) * 0.05)
        x2 += int((x2 - x1) * 0.05)
        bbox = (
            max(0, x1),
            max(0, y1),
            min(frame_width, x2),
            min(frame_height, y2),
        )
        return bbox, landmarks
