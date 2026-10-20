# sismoPA: migración a Cloudflare Pages

## 1. Actualiza GitHub con este ZIP

Reemplaza/actualiza los archivos del repositorio `robinmix/monitor-sismico-panama` con el contenido de **la carpeta interior** del ZIP. No crees un repositorio nuevo y no cambies los ajustes actuales de Netlify. Conserva archivos ocultos como `.well-known/` y `.gitignore`.

Se incluyen rutas de API para Cloudflare y redirecciones equivalentes en Netlify, de manera que el mismo sitio funciona en ambos hosts.

## 2. Compilación del proyecto Cloudflare Pages existente

- Proyecto: `sismopa` (no crear uno nuevo)
- Rama: `main`
- Preset: `Ninguno`
- Comando: `sh scripts/build-cloudflare.sh`
- Directorio de salida: `dist`
- Directorio raíz: vacío (raíz del repositorio)

Las Cloudflare Pages Functions se obtienen de la carpeta raíz `functions/`, **no** de `dist/`. No usar `npx wrangler deploy`: corresponde a Workers, no a Pages.

### Alternativa: mantener el comando actual

Si ya configuraste `mkdir -p dist && cp index.html privacidad.html manifest.webmanifest sw.js dist/ && cp -R assets .well-known dist/`, el JavaScript se desplegará, pero **no publicará** `_headers` ni `_redirects`. Conviene reemplazar el comando de compilación por el indicado arriba.

## 3. Secretos requeridos para histórico y detalle

En Cloudflare: **Workers & Pages > sismopa > Configuración / Settings > Variables and Secrets**. Añade en Production:

- `SUPABASE_URL`: URL de TU proyecto Supabase (tipo variable).
- `SUPABASE_SECRET_KEY`: clave de servidor Supabase (tipo **secret, cifrado**).

En Netlify están probablemente en **Site configuration > Environment variables**. Copia los **valores reales directamente de sus respectivos paneles**: jamás los compartas en un chat, screenshot, ZIP, GitHub ni frontend. Si la clave no es visible en Netlify, recupérala desde Supabase > Project Settings > API Keys. Usa clave de servidor válida para tu proyecto, **nunca una clave anónima de frontend**.

Después de guardarlos, vuelve a desplegar la rama `main` para que queden asociados al despliegue de producción. Configura Preview por separado si vas a probar una rama distinta.

Sin estos secretos `/api/sismos` sí funciona (datos actuales), mientras `/api/historico-sismos` y `/api/detalle-sismo` devuelven errores del servidor.

## 4. Comprobar

1. `https://sismopa.pages.dev/api/sismos` muestra JSON con `eventos`.
2. `https://sismopa.pages.dev/api/historico-sismos` muestra JSON con `ok: true` (requiere las variables).
3. `https://sismopa.pages.dev/` ya no muestra «Sin conexión» si la fuente IGC-UP responde desde Cloudflare.
4. Comprueba los gráficos, mapas, filtros, geolocalización, historial, PWA.

Si una URL `/api/` responde HTML/404, revisa si Cloudflare detectó `/functions` y la compilación. Si aparece JSON con error 502, la función existe pero no pudo acceder a la fuente externa; revisa el registro **Logs** de Pages Functions y prueba desde Cloudflare.

La fuente IGC-UP puede rechazar peticiones provenientes de Cloudflare o cambiar su formato. La migración no garantiza conectividad remota hasta probar el despliegue real.

## 5. Archivado automático cada 30 minutos: segundo paso obligatorio

**Cloudflare Pages NO tiene Cron Triggers.** El proyecto contiene un Worker separado en `cloudflare/archivador/` que ejecuta el mismo algoritmo de archivado cada 30 minutos. Para habilitarlo:

1. Con Node.js instalado en tu PC y en la carpeta del repositorio: `npx wrangler login`.
2. Entra a `cloudflare/archivador/`.
3. Configura los secretos del Worker (aparte de Pages):
   - `npx wrangler secret put SUPABASE_URL`
   - `npx wrangler secret put SUPABASE_SECRET_KEY`
4. Ejecuta `npx wrangler deploy` desde `cloudflare/archivador/`.
5. Verifica en Cloudflare **Workers & Pages > sismopa-archivador > Triggers** el cron `*/30 * * * *`, y en Observability/Logs que las ejecuciones funcionen.

**Atención:** Wrangler puede requerir desplegar el Worker **antes** de aceptar `secret put`. Si es así: entra en `cloudflare/archivador/`, ejecuta `npx wrangler deploy` primero (sin disparar manualmente el cron), luego configura los secretos y vuelve a desplegar.

El plan gratuito de Workers tiene límites diarios y de CPU; la sincronización con Supabase puede superarlos si procesa muchos eventos. Compruébalo en los logs y métricas reales. Si el cron falla, el historial dejará de recibir eventos nuevos aunque las consultas existentes sigan funcionando.

**Muy importante:** No desactives el cron de Netlify hasta verificar que este Worker archiva bien y que las filas aparecen en Supabase; después conviene desactivar el cron original para evitar dobles ingestas y créditos en Netlify.

## 6. Aspectos a mantener

- No se modifica la URL actual de Netlify ni el proyecto Android de Google Play.
- El archivo `.well-known/assetlinks.json` se copia sin cambios. La relación TWA/Android con un futuro dominio distinto deberá configurarse y verificarse por separado.
- `privacidad.html` mantiene su enlace actual, para no alterar prematuramente la ficha legal antes de elegir dominio definitivo.
- Las funciones Cloudflare son independientes de Netlify, pero requieren Supabase como servicio externo.
- La nueva web mantiene la frecuencia de consulta del navegador (5 min), pero ello no implica alertas tempranas.
