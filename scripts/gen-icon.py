#!/usr/bin/env python3
"""生成 build/icon.ico —— 256x256 深红 (#B91C1C) 纯色占位，含 16/32/48/64/128/256 六尺寸。

优先级：Pillow（若可用，更标准） > 标准库手搓 ICO（BMP 32bpp，零第三方依赖）。
打包说明见 README-打包说明.md：替换 build/icon.ico 即可换正式图标。
"""
import os
import struct

ICON_SIZES = [16, 32, 48, 64, 128, 256]
RED = (0xB9, 0x1C, 0x1C)  # #B91C1C  (R, G, B)


def make_bmp_rgba(size, rgb):
    """生成 32bpp BGRA 的 ICO 位图（XOR 像素 + 全 0 AND mask）。"""
    w = h = size
    b, g, r = rgb[2], rgb[1], rgb[0]
    pixels = bytearray()
    for _ in range(h - 1, -1, -1):            # 自底向上
        for _ in range(w):
            pixels += bytes([b, g, r, 0xFF])    # BGRA
    and_row_bytes = ((w + 31) // 32) * 4        # AND mask 行按 32 位对齐
    and_mask = bytes(and_row_bytes * h)
    header = struct.pack(
        '<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0,
        len(pixels) + len(and_mask), 0, 0, 0, 0,
    )
    return header + bytes(pixels) + and_mask


def build_ico_stdlib(path_out):
    entries = [(s, make_bmp_rgba(s, RED)) for s in ICON_SIZES]
    out = bytearray()
    out += struct.pack('<HHH', 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    for s, img in entries:
        w = 0 if s >= 256 else s
        out += struct.pack('<BBBBHHII', w, w, 0, 0, 1, 32, len(img), offset)
        offset += len(img)
    for _, img in entries:
        out += img
    with open(path_out, 'wb') as f:
        f.write(out)


def build_ico_pil(path_out):
    from PIL import Image
    imgs = [Image.new('RGBA', (s, s), RED + (255,)) for s in ICON_SIZES]
    imgs[0].save(path_out, format='ICO', sizes=[(s, s) for s in ICON_SIZES])


def main():
    # 脚本位于 scripts/，图标产物放到项目根的 build/icon.ico
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(root, 'build', 'icon.ico')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    try:
        build_ico_pil(out)
        print('[gen-icon] 使用 Pillow 生成 ->', out)
    except ImportError:
        build_ico_stdlib(out)
        print('[gen-icon] Pillow 不可用，使用标准库生成 ->', out)
    print('[gen-icon] 尺寸:', ICON_SIZES, ' 颜色 #B91C1C')


if __name__ == '__main__':
    main()
