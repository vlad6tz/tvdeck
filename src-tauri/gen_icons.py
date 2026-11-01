#!/usr/bin/env python3
"""Generate TVDeck app icons (PNG / ICO / ICNS) without external tools."""
import struct, zlib, os

def png_bytes(w, h, px):
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    # one filter byte (None) + this row's scanline, per row
    raw = b''.join(
        b'\x00' + px[(y * w * 4):((y + 1) * w * 4)] for y in range(h)
    )
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))

def make_px(size):
    # TVDeck mark: dark slate rounded square, white screen bar, cyan strip.
    px = bytearray()
    for y in range(size):
        for x in range(size):
            fx, fy = x / size, y / size
            r = 0.18
            inside = True
            for cx, cy in [(r, r), (1 - r, r), (r, 1 - r), (1 - r, 1 - r)]:
                dx, dy = fx - cx, fy - cy
                corner = (fx < r or fx > 1 - r) and (fy < r or fy > 1 - r)
                if corner and dx * dx + dy * dy > r * r:
                    inside = False
            if inside:
                if 0.30 <= fy <= 0.62 and 0.18 <= fx <= 0.82:
                    px += bytes((255, 255, 255, 255))    # screen bar
                elif 0.66 <= fy <= 0.74 and 0.18 <= fx <= 0.82:
                    px += bytes((34, 211, 238, 255))     # cyan strip
                else:
                    px += bytes((16, 26, 46, 255))       # slate panel
            else:
                px += bytes((0, 0, 0, 0))                # transparent
    return bytes(px)

outdir = os.path.join(os.path.dirname(__file__), 'out')
os.makedirs(outdir, exist_ok=True)

for name, size in [('32x32.png', 32), ('128x128.png', 128), ('128x128@2x.png', 256)]:
    open(os.path.join(outdir, name), 'wb').write(png_bytes(size, size, make_px(size)))

# ICO (256 png-compressed entry)
ico_png = png_bytes(256, 256, make_px(256))
ico = struct.pack('<HHH', 0, 1, 1)
ico += struct.pack('<BBBBHHII', 0, 0, 0, 0, 1, 32, 0, 22 + len(ico_png))
open(os.path.join(outdir, 'icon.ico'), 'wb').write(ico + ico_png)

# ICNS with ic07 (128 png) + ic08 (256 png)
png128 = png_bytes(128, 128, make_px(128))
icns_body = b'ic07' + struct.pack('>I', len(png128) + 8) + png128
icns_body += b'ic08' + struct.pack('>I', len(ico_png) + 8) + ico_png
open(os.path.join(outdir, 'icon.icns'), 'wb').write(b'icns' + struct.pack('>I', len(icns_body) + 8) + icns_body)

print('icons written to', outdir)
