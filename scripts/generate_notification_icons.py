"""
generate_notification_icons.py
Genera los iconos monocromáticos transparentes para Web Push (badge)
y recursos drawable de notificación para Android TWA (ic_notification_icon).
Todos los píxeles son blanco puro (#FFFFFF) con transparencia alfa adecuada.
"""

import os
import math
from PIL import Image

def generate_icons(project_root):
    fg_path = os.path.join(project_root, "android-twa", "sismopa_master_fg_1024.png")
    if not os.path.exists(fg_path):
        raise FileNotFoundError(f"No se encontró: {fg_path}")

    fg = Image.open(fg_path)
    cx, cy = 512, 512
    radius = 324

    # 1. Extraer silueta monocromática pura (RGB 255, 255, 255 con alfa)
    mono_master = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    for y in range(1024):
        for x in range(1024):
            dist = math.hypot(x - cx, y - cy)
            if dist <= radius:
                pr, pg, pb, pa = fg.getpixel((x, y))
                if pa > 25:
                    # Suavizado de bordes preservando alfa
                    mono_master.putpixel((x, y), (255, 255, 255, pa))

    bbox = mono_master.getbbox()
    emblem = mono_master.crop(bbox)
    ew, eh = emblem.size
    print(f"[Iconos] Silueta del emblema extraída: {ew}x{eh} px")

    # Función auxiliar para colocar el emblema centrado con padding
    def render_canvas(size, target_content_size):
        canvas = Image.new("RGBA", (size, size), (255, 255, 255, 0))
        scale = target_content_size / max(ew, eh)
        nw = max(1, int(round(ew * scale)))
        nh = max(1, int(round(eh * scale)))
        scaled = emblem.resize((nw, nh), Image.Resampling.LANCZOS)
        
        # Garantizar pureza monocromática absoluta: RGB siempre (255, 255, 255)
        scaled_alpha = scaled.getchannel('A')
        pure_scaled = Image.new("RGBA", scaled.size, (255, 255, 255, 0))
        pure_scaled.putalpha(scaled_alpha)

        offset_x = (size - nw) // 2
        offset_y = (size - nh) // 2
        canvas.paste(pure_scaled, (offset_x, offset_y))
        return canvas

    # 2. Generar badges para Web Push en assets/icons/
    assets_dir = os.path.join(project_root, "assets", "icons")
    os.makedirs(assets_dir, exist_ok=True)

    badge_96 = render_canvas(96, 80)
    badge_96_path = os.path.join(assets_dir, "badge-96.png")
    badge_96.save(badge_96_path, "PNG")
    print(f"[Iconos] Guardado: {badge_96_path}")

    badge_72 = render_canvas(72, 60)
    badge_72_path = os.path.join(assets_dir, "badge-72.png")
    badge_72.save(badge_72_path, "PNG")
    print(f"[Iconos] Guardado: {badge_72_path}")

    # 3. Generar recursos ic_notification_icon para Android TWA
    android_res_dir = os.path.join(project_root, "android-twa", "app", "src", "main", "res")
    densities = {
        "drawable-mdpi": (24, 20),
        "drawable-hdpi": (36, 30),
        "drawable-xhdpi": (48, 40),
        "drawable-xxhdpi": (72, 60),
        "drawable-xxxhdpi": (96, 80),
    }

    for folder, (size, content_size) in densities.items():
        target_dir = os.path.join(android_res_dir, folder)
        os.makedirs(target_dir, exist_ok=True)
        icon_img = render_canvas(size, content_size)
        target_file = os.path.join(target_dir, "ic_notification_icon.png")
        icon_img.save(target_file, "PNG")
        print(f"[Iconos] Guardado Android: {target_file} ({size}x{size})")

    print("\n[Iconos] Generación de iconos monocromáticos completada con éxito.")

if __name__ == "__main__":
    import sys
    root = sys.argv[1] if len(sys.argv) > 1 else os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    generate_icons(root)
