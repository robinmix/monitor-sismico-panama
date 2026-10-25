# Capturas Oficiales de sismoPA para Google Play Store

Este directorio está destinado a recibir las **4 capturas de pantalla reales** tomadas directamente desde su teléfono Samsung con la aplicación sismoPA instalada y ejecutándose a pantalla completa (Trusted Web Activity).

---

## Archivos Esperados

| Archivo | Pantalla Requerida en sismoPA | Descripción |
| :--- | :--- | :--- |
| `screenshot_1_catalogo.png` (o `.jpg`) | Pestaña **Sismos** | Vista principal con la lista/tarjetas de los últimos sismos registrados, mostrando magnitudes y localidades reales del IGC-UP. |
| `screenshot_2_mapa.png` (o `.jpg`) | Pestaña **Mapa** | Cartografía interactiva de la República de Panamá mostrando los marcadores epicentrales sobre el territorio nacional. |
| `screenshot_3_cerca.png` (o `.jpg`) | Pestaña **Cerca** | Sección de proximidad mostrando la distancia calculada en kilómetros respecto a su ubicación. |
| `screenshot_4_historial.png` (o `.jpg`) | Pestaña **Historial** | Vista de consulta cronológica y filtros por fecha de los registros acumulados. |

---

## Cómo Tomar las Capturas en su Samsung

1. Abra la aplicación **sismoPA** en su teléfono móvil (debe verse a pantalla completa sin barra de navegación del navegador gracias a Digital Asset Links).
2. Navegue a cada una de las 4 pestañas mencionadas y espere a que cargue la información real.
3. Presione simultáneamente el botón **Encendido + Bajar Volumen** (o deslice el lateral de la mano sobre la pantalla).
4. Copie los 4 archivos de imagen resultantes a esta carpeta (`android-twa/screenshots/`).

---

## Verificación que Realizaremos Automáticamente al Recibirlas

En cuanto coloque los 4 archivos en este directorio:
- Comprobaremos que tengan resolución vertical estándar (ej. 1080 × 2400 o 1080 × 1920 px, relación de aspecto 9:16).
- Confirmaremos que el formato sea PNG de 24 bits sin canal alfa (o JPG), con peso menor a 8 MB por imagen según las directrices de Google Play.
- Si las imágenes vienen en formato JPG o con dimensiones nativas de pantalla completa Samsung (20:9 o 21:9), prepararemos las versiones optimizadas sin recortar ni distorsionar la interfaz real.
