# Face Models

`face_detection_yunet_2023mar.onnx` comes from the official
[OpenCV Zoo YuNet model](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet).
The upstream model directory is licensed under the MIT License.

- SHA-256: `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`
- Purpose: local five-point face landmark detection for the optional LongCat
  mouth compositor
- Runtime: OpenCV DNN on CPU; it does not start a DGX model

`face_recognition_sface_2021dec.onnx` comes from the official
[OpenCV SFace repository](https://huggingface.co/opencv/face_recognition_sface)
at revision `3d7082438a6e4551e840c9b2bb60b71e8da4b524`. The complete upstream
SFace directory, including the model, is licensed under Apache License 2.0.

- SHA-256: `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79`
- Size: `38,696,353` bytes
- Purpose: local reference-to-output identity similarity measurements
- Runtime: OpenCV DNN on CPU with `CUDA_VISIBLE_DEVICES=""`
- Verified interface: YuNet five-point alignment to `112 x 112`, output `1 x 128`
  with OpenCV 4.13.0
- Privacy: only aggregate similarities are persisted; embeddings are discarded
- License copy: `SFACE-LICENSE.txt`
