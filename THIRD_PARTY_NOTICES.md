# Third-party notices

Buz Cards is MIT licensed. It installs and uses the following components (via npm); their own licenses apply.

## Recognition models (data files, installed from npm)

| Model | Source package | License |
| --- | --- | --- |
| PP-OCRv5 mobile text detection (`PP-OCRv5_mobile_det_infer.ort`) and multilingual recognition (`PP-OCRv5_mobile_rec_infer.onnx`, `ppocrv5_dict.txt`) | `pdfmarkdown-ppocrv5-models` (redistribution of PaddleOCR models via ppu-paddle-ocr-models) | Apache-2.0 |
| English PP-OCRv4 recognition (`en_PP-OCRv4_rec.onnx`) and text-angle classifier (`ch_ppocr_mobile_v2.0_cls_infer.onnx`) | `paddle-ocr-onnx-models` (redistribution of RapidOCR conversions of PaddleOCR models) | Apache-2.0 |
| English character dictionary (`server/recognition/en_dict.txt`) | PaddleOCR repository (`ppocr/utils/en_dict.txt`) | Apache-2.0 |

PaddleOCR: Copyright (c) PaddlePaddle Authors — https://github.com/PaddlePaddle/PaddleOCR (Apache License 2.0).

## Runtime libraries

| Library | Purpose | License |
| --- | --- | --- |
| onnxruntime-node | runs the OCR models on the CPU | MIT |
| @techstark/opencv-js (OpenCV) | card outline, perspective, image ops | Apache-2.0 |
| sharp (libvips) | image decoding/encoding, EXIF orientation | Apache-2.0 (libvips LGPL-3.0, dynamically linked prebuilt) |
| heic-decode (libheif, libde265 compiled to WebAssembly) | iPhone HEIC photos | MIT (libheif/libde265: LGPL-3.0) |
| jsQR | QR codes on cards | Apache-2.0 |
| word-list | English word list used to choose between OCR readings | MIT |
| Express | HTTP server | MIT |
| ExcelJS | .xlsx export | MIT |
| fflate | .zip backups | MIT |
| selfsigned | optional self-signed HTTPS certificate | MIT |
| React, react-dom | web app | MIT |
| idb | IndexedDB upload queue | ISC |
| lucide-react | icons | ISC |
| @fontsource/public-sans (Public Sans) | typeface | SIL Open Font License 1.1 |
| vite, vite-plugin-pwa (Workbox) | build, service worker | MIT |

Development only: TypeScript (Apache-2.0), Vitest (MIT), Playwright (Apache-2.0), Prettier (MIT), qrcode (MIT, synthetic fixtures). The synthetic fixture generator `scripts/synthetic/compose.py` optionally uses Python with OpenCV, NumPy and Pillow.

Run `npm ls --all` for the full dependency tree.
