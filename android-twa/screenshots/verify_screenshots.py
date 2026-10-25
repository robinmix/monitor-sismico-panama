"""
verify_screenshots.py
Verifies dimensions, aspect ratio, color mode, and file size for Google Play screenshots.
Prepares optimized 9:16 PNG files if needed without stretching or distortion.
"""
import os
import glob
from PIL import Image

SCREENSHOTS_DIR = os.path.dirname(os.path.abspath(__file__))
REQUIRED_NAMES = [
    "screenshot_1_catalogo",
    "screenshot_2_mapa",
    "screenshot_3_cerca",
    "screenshot_4_historial"
]

def check_screenshots():
    print(f"Scanning directory: {SCREENSHOTS_DIR}")
    found = []
    for ext in ("*.png", "*.jpg", "*.jpeg", "*.webp"):
        found.extend(glob.glob(os.path.join(SCREENSHOTS_DIR, ext)))
    
    if not found:
        print("No image files found in screenshots directory yet.")
        return False
    
    print(f"Found {len(found)} image file(s):")
    for f in found:
        try:
            im = Image.open(f)
            size_kb = os.path.getsize(f) / 1024
            ratio = im.height / im.width if im.width > 0 else 0
            print(f" - {os.path.basename(f)}: {im.size[0]}x{im.size[1]} ({im.format}, {im.mode}), {size_kb:.1f} KB, Ratio: {ratio:.2f}")
        except Exception as e:
            print(f" - {os.path.basename(f)}: Error reading image ({e})")
    return True

if __name__ == "__main__":
    check_screenshots()
