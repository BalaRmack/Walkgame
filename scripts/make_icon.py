#!/usr/bin/env python3
"""Генерирует иконку Noir Browser: градиентный месяц + звезда-искра на чёрном скруглённом квадрате.
Результат: build/icon.png (512x512) и build/icon.ico (мультиразмер для Windows).
Запуск: python3 scripts/make_icon.py  (нужен Pillow)"""
from PIL import Image, ImageDraw, ImageFilter
import os

S = 1024  # рисуем в 2x и даунскейлим для сглаживания
OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'build')
os.makedirs(OUT_DIR, exist_ok=True)

def gradient(size, stops):
    """Диагональный градиент по списку цветов."""
    base = Image.new('RGB', (size, size))
    px = base.load()
    n = len(stops) - 1
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            i = min(int(t * n), n - 1)
            lt = t * n - i
            a, b = stops[i], stops[i + 1]
            px[x, y] = tuple(int(a[c] + (b[c] - a[c]) * lt) for c in range(3))
    return base

# Фон: чёрный скруглённый квадрат с лёгким свечением по краям
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([8, 8, S - 8, S - 8], radius=210, fill=(15, 15, 18, 255))

# Градиент фирменных цветов Brave-стиля: оранжевый -> малиновый -> фиолетовый
grad = gradient(S, [(255, 113, 57), (255, 45, 120), (162, 89, 255)]).convert('RGBA')

# Месяц: градиентный круг минус смещённый круг цвета фона
moon_mask = Image.new('L', (S, S), 0)
md = ImageDraw.Draw(moon_mask)
md.ellipse([212, 172, 852, 812], fill=255)
moon = Image.new('RGBA', (S, S), (0, 0, 0, 0))
moon.paste(grad, (0, 0), moon_mask)
cut = Image.new('RGBA', (S, S), (0, 0, 0, 0))
cd = ImageDraw.Draw(cut)
cd.ellipse([372, 112, 972, 712], fill=(15, 15, 18, 255))
moon.alpha_composite(cut)
img.alpha_composite(moon)

# Звезда-искра (4-конечная) справа вверху — намёк на ИИ
star = Image.new('RGBA', (S, S), (0, 0, 0, 0))
sd = ImageDraw.Draw(star)
cx, cy, R, r = 712, 300, 118, 30
pts = [(cx, cy - R), (cx + r, cy - r), (cx + R, cy), (cx + r, cy + r),
       (cx, cy + R), (cx - r, cy + r), (cx - R, cy), (cx - r, cy - r)]
sd.polygon(pts, fill=(255, 255, 255, 255))
glow = star.filter(ImageFilter.GaussianBlur(16))
img.alpha_composite(glow)
img.alpha_composite(star)

# Маленькая звёздочка для баланса
sd2 = ImageDraw.Draw(img)
cx, cy, R, r = 800, 560, 52, 14
pts = [(cx, cy - R), (cx + r, cy - r), (cx + R, cy), (cx + r, cy + r),
       (cx, cy + R), (cx - r, cy + r), (cx - R, cy), (cx - r, cy - r)]
sd2.polygon(pts, fill=(255, 255, 255, 220))

final = img.resize((512, 512), Image.LANCZOS)
final.save(os.path.join(OUT_DIR, 'icon.png'))
final.save(os.path.join(OUT_DIR, 'icon.ico'),
           sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('icon.png + icon.ico ->', os.path.abspath(OUT_DIR))
