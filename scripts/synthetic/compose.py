"""Turn flat synthetic cards into photo-like test images (perspective, clutter, lighting, JPEG).

Public regression fixtures only -- not a substitute for real card photos.
Usage: python scripts/synthetic/compose.py
"""
import glob
import json
import os
import random

import cv2
import numpy as np
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
FLAT = os.path.join(ROOT, 'tests', 'fixtures', 'synthetic', 'flat')
OUT = os.path.join(ROOT, 'tests', 'fixtures', 'synthetic', 'photos')
os.makedirs(OUT, exist_ok=True)
rng = random.Random(7)


def wood(w, h):
    x = np.linspace(0, 40, w)[None, :] + np.random.RandomState(1).rand(h, 1) * 6
    g = (np.sin(x + np.sin(np.linspace(0, 9, h))[:, None] * 2) * 0.5 + 0.5)
    img = np.stack([60 + 50 * g, 95 + 60 * g, 140 + 70 * g], -1)  # BGR brownish
    return img.astype(np.uint8)


def keyboard(w, h):
    img = np.full((h, w, 3), 35, np.uint8)
    keys = 'QWERTYUIOPASDFGHJKLZXCVBNM1234567890'
    k = max(w // 18, 60)
    for yy in range(0, h, k + 10):
        for xx in range(0, w, k + 10):
            cv2.rectangle(img, (xx, yy), (xx + k, yy + k), (70, 70, 70), -1)
            cv2.putText(img, rng.choice(keys), (xx + k // 4, yy + 2 * k // 3), cv2.FONT_HERSHEY_SIMPLEX, k / 60, (225, 225, 225), 3)
    return img


def table_with_papers(w, h):
    img = np.full((h, w, 3), (205, 215, 220), np.uint8)
    for i in range(8):
        y = rng.randint(0, h)
        cv2.putText(img, 'Exhibitor Hall B  Stand 4' + str(i), (rng.randint(-200, w // 2), y), cv2.FONT_HERSHEY_SIMPLEX, 2.2, (120, 120, 120), 4)
    return img


BACKGROUNDS = [wood, keyboard, table_with_papers]


def compose(card_bgr, bg_fn, size=(3024, 2268), scale=0.62, angle=0.0, persp=0.04, rot90=0, blur=0.0, shadow=True, quality=88):
    W, H = size
    bg = bg_fn(W, H)
    ch, cw = card_bgr.shape[:2]
    tw = int(W * scale)
    th = int(tw * ch / cw)
    cx, cy = W / 2 + rng.uniform(-0.05, 0.05) * W, H / 2 + rng.uniform(-0.05, 0.05) * H
    src = np.float32([[0, 0], [cw, 0], [cw, ch], [0, ch]])
    base = np.float32([[-tw / 2, -th / 2], [tw / 2, -th / 2], [tw / 2, th / 2], [-tw / 2, th / 2]])
    a = np.deg2rad(angle)
    R = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]])
    dst = base @ R.T
    dst += np.float32([[rng.uniform(-persp, persp) * tw, rng.uniform(-persp, persp) * th] for _ in range(4)])
    dst += np.float32([cx, cy])
    M = cv2.getPerspectiveTransform(src, dst.astype(np.float32))
    warped = cv2.warpPerspective(card_bgr, M, (W, H), flags=cv2.INTER_CUBIC)
    mask = cv2.warpPerspective(np.full((ch, cw), 255, np.uint8), M, (W, H))
    if shadow:
        sh = cv2.GaussianBlur(np.roll(np.roll(mask, 25, 0), 25, 1), (0, 0), 25)
        bg = (bg * (1 - 0.45 * sh[..., None] / 255)).astype(np.uint8)
    out = np.where(mask[..., None] > 0, warped, bg)
    # uneven lighting
    gx = np.linspace(0.82, 1.08, W)[None, :] * np.linspace(1.05, 0.9, H)[:, None]
    out = np.clip(out * gx[..., None], 0, 255).astype(np.uint8)
    if blur:
        out = cv2.GaussianBlur(out, (0, 0), blur)
    noise = np.random.RandomState(3).normal(0, 4, out.shape)
    out = np.clip(out + noise, 0, 255).astype(np.uint8)
    if rot90:
        out = np.ascontiguousarray(np.rot90(out, rot90))
    return out, quality


def main():
    cards = json.load(open(os.path.join(ROOT, 'tests', 'fixtures', 'synthetic', 'cards.json')))
    manifest = []
    for i, card in enumerate(cards):
        flat = cv2.imread(os.path.join(FLAT, card['id'] + '.png'))
        bg = BACKGROUNDS[i % len(BACKGROUNDS)]
        angle = rng.uniform(-9, 9)
        # A few harder variants: rotated sideways via EXIF, upside down, small in frame, blurred.
        rot90 = 0
        exif_orientation = None
        scale = rng.uniform(0.55, 0.75)
        blur = 0.0
        if card['id'] == 's04-dark':
            exif_orientation = 6  # stored sideways; EXIF says rotate 90 CW to display
        if card['id'] == 's09-caps':
            angle += 180
        if card['id'] == 's10-lowcontrast':
            blur = 1.6
        if card['id'] == 's05-dense':
            scale = 0.42
        img, q = compose(flat, bg, scale=scale, angle=angle, rot90=rot90, blur=blur)
        name = card['id'] + '.jpg'
        rgb = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
        if exif_orientation == 6:
            # Pixel data stored rotated 90 deg CCW; orientation 6 tells viewers to rotate it back.
            rgb = rgb.transpose(Image.ROTATE_90)
            exif = Image.Exif()
            exif[0x0112] = 6
            rgb.save(os.path.join(OUT, name), quality=q, exif=exif)
        else:
            rgb.save(os.path.join(OUT, name), quality=q)
        manifest.append({'file': name, 'id': card['id']})
    json.dump(manifest, open(os.path.join(OUT, 'manifest.json'), 'w'), indent=2)
    print('wrote', len(manifest), 'photos to', OUT)


if __name__ == '__main__':
    main()
