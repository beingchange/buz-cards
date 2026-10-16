// Locates the ONNX model files. They are installed from npm packages (no separate download step):
//   pdfmarkdown-ppocrv5-models  -> PP-OCRv5 mobile detection + multilingual recognition (Apache-2.0)
//   paddle-ocr-onnx-models      -> English PP-OCRv4 recognition + angle classifier (Apache-2.0)
// Paths can be overridden with BUZ_MODEL_DIR (expects the same file names) for offline installs.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { ModelPaths } from './paddle.ts';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..', '..');

function pkgDir(name: string): string | null {
  try {
    return path.dirname(require.resolve(`${name}/package.json`));
  } catch {
    return null;
  }
}

function firstExisting(...candidates: (string | null)[]): string | null {
  for (const c of candidates) if (c && existsSync(c)) return c;
  return null;
}

export class ModelsMissingError extends Error {}

export function resolveModels(): { primary: ModelPaths; secondary: ModelPaths | null } {
  const custom = process.env.BUZ_MODEL_DIR ? path.resolve(process.env.BUZ_MODEL_DIR) : null;
  const local = path.join(ROOT, 'models');
  const v5 = pkgDir('pdfmarkdown-ppocrv5-models');
  const pom = pkgDir('paddle-ocr-onnx-models');
  const at = (dir: string | null, ...p: string[]) => (dir ? path.join(dir, ...p) : null);

  const det = firstExisting(
    at(custom, 'PP-OCRv5_mobile_det_infer.ort'),
    at(v5, 'detection', 'PP-OCRv5_mobile_det_infer.ort'),
    at(local, 'PP-OCRv5_mobile_det_infer.ort'),
  );
  const rec = firstExisting(
    at(custom, 'PP-OCRv5_mobile_rec_infer.onnx'),
    at(v5, 'recognition', 'PP-OCRv5_mobile_rec_infer.onnx'),
    at(local, 'PP-OCRv5_mobile_rec_infer.onnx'),
  );
  const dict = firstExisting(at(custom, 'ppocrv5_dict.txt'), at(v5, 'recognition', 'ppocrv5_dict.txt'), at(local, 'ppocrv5_dict.txt'));
  const cls = firstExisting(
    at(custom, 'ch_ppocr_mobile_v2.0_cls_infer.onnx'),
    at(pom, 'models', 'ch_ppocr_mobile_v2.0_cls_infer.onnx'),
    at(local, 'ch_ppocr_mobile_v2.0_cls_infer.onnx'),
  );
  const enRec = firstExisting(at(custom, 'en_PP-OCRv4_rec.onnx'), at(pom, 'models', 'en_PP-OCRv4_rec.onnx'), at(local, 'en_PP-OCRv4_rec.onnx'));
  const enDict = firstExisting(at(custom, 'en_dict.txt'), path.join(ROOT, 'server', 'recognition', 'en_dict.txt'));
  if (!det || !rec || !dict)
    throw new ModelsMissingError('OCR model files are missing. Run "npm install" (models are installed from npm), or set BUZ_MODEL_DIR.');
  return {
    primary: { det, rec, dict, cls: cls ?? undefined },
    secondary: enRec && enDict ? { det, rec: enRec, dict: enDict, cls: cls ?? undefined } : null,
  };
}
