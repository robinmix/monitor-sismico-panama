"""
generate_sismopa_assets.py
Generates all Android icon and splash assets for sismoPA (PASO 22A)
from the uploaded master image, eliminating the simulated checkerboard
and ensuring perfect adaptive icon compliance, seamless splash screen,
and legacy launcher support.
"""

import os
import math
from PIL import Image, ImageDraw

def generate():
    src_path = r"C:\Users\robin\.gemini\antigravity\brain\5133a983-5a0a-4260-865b-1bb33c769499\.user_uploaded\media_1792435480213_a0790929.jpg"
    base_res_dir = r"android-twa\app\src\main\res"
    twa_dir = r"android-twa"

    img = Image.open(src_path).convert("RGB")
    w, h = img.size

    # Original center is (508, 508). Shift by +4, +4 so center is exactly (512, 512).
    shift_x, shift_y = 4, 4
    cx, cy = 512, 512
    base_blue = (8, 60, 120)  # #083c78

    print("Step 1: Building 1024x1024 master full image...")
    master_full = Image.new("RGB", (1024, 1024), base_blue)
    
    # Outer ring radius is 320 px. Transition up to 324 px.
    for y in range(1024):
        for x in range(1024):
            sx = x - shift_x
            sy = y - shift_y
            r = math.hypot(x - cx, y - cy)
            
            if 0 <= sx < w and 0 <= sy < h and r < 324:
                master_full.putpixel((x, y), img.getpixel((sx, sy)))
            elif 504 <= y <= 525:
                # Horizontal red line extends outward across the full canvas
                ref_sx = 165 if x < cx else 850
                ref_sy = y - shift_y
                if 0 <= ref_sy < h:
                    master_full.putpixel((x, y), img.getpixel((ref_sx, ref_sy)))
                else:
                    master_full.putpixel((x, y), base_blue)
            else:
                master_full.putpixel((x, y), base_blue)

    master_full_path = os.path.join(twa_dir, "sismopa_master_full_1024.png")
    master_full.save(master_full_path, "PNG")
    print(f"Master full saved to: {master_full_path}")

    print("Step 2: Building 1024x1024 master foreground image (transparent background)...")
    master_fg = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    for y in range(1024):
        for x in range(1024):
            r, g, b = master_full.getpixel((x, y))
            d = math.sqrt((r - base_blue[0])**2 + (g - base_blue[1])**2 + (b - base_blue[2])**2)
            if d <= 5:
                continue
            elif d >= 25:
                master_fg.putpixel((x, y), (r, g, b, 255))
            else:
                a = int(round(255 * (d - 5) / 20))
                master_fg.putpixel((x, y), (r, g, b, a))

    master_fg_path = os.path.join(twa_dir, "sismopa_master_fg_1024.png")
    master_fg.save(master_fg_path, "PNG")
    print(f"Master foreground saved to: {master_fg_path}")

    # Helper for circular masked round icon
    def create_round_icon(img_square):
        size = img_square.size[0]
        mask = Image.new("L", (size * 4, size * 4), 0)
        draw = ImageDraw.Draw(mask)
        draw.ellipse((2, 2, size * 4 - 3, size * 4 - 3), fill=255)
        mask = mask.resize((size, size), Image.Resampling.LANCZOS)
        
        round_img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        round_img.paste(img_square.convert("RGBA"), (0, 0), mask)
        return round_img

    print("Step 3: Generating store_icon.png (512x512)...")
    store_icon = master_full.resize((512, 512), Image.Resampling.LANCZOS)
    store_icon_path = os.path.join(twa_dir, "store_icon.png")
    store_icon.save(store_icon_path, "PNG")
    print(f"store_icon.png saved: {store_icon.size}")

    print("Step 4: Generating splash.png across densities...")
    splash_sizes = {
        "mdpi": (300, 300),
        "hdpi": (450, 450),
        "xhdpi": (600, 600),
        "xxhdpi": (900, 900),
        "xxxhdpi": (1200, 1200),
    }
    for density, size in splash_sizes.items():
        splash_dir = os.path.join(base_res_dir, f"drawable-{density}")
        os.makedirs(splash_dir, exist_ok=True)
        splash_img = master_full.resize(size, Image.Resampling.LANCZOS)
        splash_file = os.path.join(splash_dir, "splash.png")
        splash_img.save(splash_file, "PNG")
        print(f"Saved {splash_file}: {size}")

    print("Step 5: Generating launcher icons (ic_launcher, ic_launcher_round, ic_launcher_foreground, ic_maskable)...")
    densities = {
        "mdpi": {
            "launcher": 48,
            "maskable": 82,
            "foreground": 108,
        },
        "hdpi": {
            "launcher": 72,
            "maskable": 123,
            "foreground": 162,
        },
        "xhdpi": {
            "launcher": 96,
            "maskable": 164,
            "foreground": 216,
        },
        "xxhdpi": {
            "launcher": 144,
            "maskable": 246,
            "foreground": 324,
        },
        "xxxhdpi": {
            "launcher": 192,
            "maskable": 328,
            "foreground": 432,
        },
    }

    for density, config in densities.items():
        mipmap_dir = os.path.join(base_res_dir, f"mipmap-{density}")
        os.makedirs(mipmap_dir, exist_ok=True)

        l_size = config["launcher"]
        m_size = config["maskable"]
        fg_size = config["foreground"]

        # ic_launcher.png (legacy standard full-bleed)
        ic_launcher = master_full.resize((l_size, l_size), Image.Resampling.LANCZOS)
        ic_launcher_path = os.path.join(mipmap_dir, "ic_launcher.png")
        ic_launcher.save(ic_launcher_path, "PNG")

        # ic_launcher_round.png (legacy round)
        ic_round = create_round_icon(ic_launcher)
        ic_round_path = os.path.join(mipmap_dir, "ic_launcher_round.png")
        ic_round.save(ic_round_path, "PNG")

        # ic_maskable.png (PWA / WebAPK maskable standard)
        ic_maskable = master_full.resize((m_size, m_size), Image.Resampling.LANCZOS)
        ic_maskable_path = os.path.join(mipmap_dir, "ic_maskable.png")
        ic_maskable.save(ic_maskable_path, "PNG")

        # ic_launcher_foreground.png (Android Adaptive Icon 108dp foreground)
        ic_fg = master_fg.resize((fg_size, fg_size), Image.Resampling.LANCZOS)
        ic_fg_path = os.path.join(mipmap_dir, "ic_launcher_foreground.png")
        ic_fg.save(ic_fg_path, "PNG")

        print(f"Generated mipmap-{density}: launcher={l_size}px, round={l_size}px, maskable={m_size}px, foreground={fg_size}px")

    print("\nAll assets generated successfully!")

if __name__ == "__main__":
    generate()
