"""Génère le logo GoldWatch CI (repère doré + cours d'eau sur fond vert).

    python tool/make_icon.py && dart run flutter_launcher_icons

Produit assets/icon/icon.png (icône complète) et assets/icon/icon_foreground.png
(premier plan transparent de l'icône adaptative Android, fond #1B4332).
"""
import math
import os

from PIL import Image, ImageDraw

S = 4        # suréchantillonnage pour des bords lisses
N = 1024
GREEN = (27, 67, 50, 255)
GOLD = (184, 138, 0, 255)
LIGHT = (230, 239, 233, 255)
BLUE = (120, 190, 230, 255)


def draw(bg, pin_scale, waves):
    im = Image.new('RGBA', (N * S, N * S), bg)
    d = ImageDraw.Draw(im)
    cx, cy = N * S // 2, int(N * S * 0.40)
    r = int(N * S * 0.20 * pin_scale)

    if waves:  # cercles juxtaposés : bords lisses, dans la zone sûre des icônes rondes
        for k, (off, col) in enumerate(((0.775, BLUE), (0.845, LIGHT))):
            rad = int(N * S * 0.0125)
            x = N * S * 0.26
            while x <= N * S * 0.74:
                y = N * S * off + math.sin((x / (N * S) - 0.26) / 0.48 * math.pi * 3 + k) * N * S * 0.014
                d.ellipse([x - rad, y - rad, x + rad, y + rad], fill=col)
                x += 2

    # repère : tête ronde, pointe, trou
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GOLD)
    a = math.radians(38)
    d.polygon([(cx - r * math.sin(a), cy + r * math.cos(a)),
               (cx + r * math.sin(a), cy + r * math.cos(a)),
               (cx, cy + r * 1.85)], fill=GOLD)
    h = int(r * 0.38)
    d.ellipse([cx - h, cy - h, cx + h, cy + h], fill=GREEN)
    return im.resize((N, N), Image.LANCZOS)


if __name__ == '__main__':
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'icon')
    os.makedirs(out, exist_ok=True)
    draw(GREEN, 1.0, True).save(os.path.join(out, 'icon.png'))
    draw((0, 0, 0, 0), 0.82, False).save(os.path.join(out, 'icon_foreground.png'))
    print('icônes écrites dans', out)
