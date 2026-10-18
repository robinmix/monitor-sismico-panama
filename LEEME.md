# SISMODATA Panamá · Monitor sísmico IGC-UP

Sitio web independiente que obtiene **todos los datos de eventos sísmicos exclusivamente de https://sismosgeociencias.up.ac.pa/**. No consulta feeds sísmicos de USGS, EMSC, IRIS ni ningún otro organismo.

## Contenido

- Total de eventos en los últimos 7 días, con selección de 12, 24, 48 y 72 horas, o toda la lista disponible en el IGC-UP.
- Magnitudes separadas en cuatro categorías: **M < 3.0**, **3.0 ≤ M < 4.0**, **4.0 ≤ M < 5.0** y **M ≥ 5.0**. Cada evento se suma a una única categoría.
- Contador vivo de días/horas/minutos/segundos desde el último evento publicado, independiente de los filtros.
- Gráfica de actividad diaria/horaria y gráfica circular de magnitudes.
- Filtros por región reportada por el IGC-UP, localidad de referencia, profundidad, estado, fechas, búsqueda, magnitud y orden de registros.
- Mapa interactivo de epicentros, con plano de coordenadas alternativo si no se pueden cargar los mapas base.
- Conteo por región y localidad; lista de sismos paginada; exportación de resultados filtrados a CSV compatible con Excel.
- Actualización automática cada 5 minutos y manual mediante el botón «Actualizar».
- Diseño adaptado a computadoras y teléfonos.

## Despliegue en Netlify (recomendado: Git)

**Importante:** la función Netlify `netlify/functions/sismos.js` es necesaria para consultar la web del IGC-UP. Subir solo `index.html` o arrastrar únicamente la carpeta de archivos estáticos NO basta.

1. Descomprime el ZIP de este proyecto (incluye `index.html`, `assets/`, `netlify/`, `netlify.toml` y `package.json`).
2. Crea un repositorio de GitHub con **todo el contenido de la carpeta raíz**.
3. En Netlify, selecciona **Add new project → Import an existing project** y conecta el repositorio.
4. Como directorio de publicación utiliza `.` (el archivo `netlify.toml` ya lo define). No es necesario un comando de compilación ni instalar paquetes adicionales.
5. Al publicarse, abre `https://TU-SITIO.netlify.app/.netlify/functions/sismos`. Debe mostrar un JSON con `totalFuente` y `eventos`.
6. Abre la página principal: los contadores, los gráficos y el listado se llenan automáticamente.

### Opción de Netlify CLI

Si prefieres no usar GitHub, instala la CLI de Netlify y, dentro de la carpeta del proyecto, ejecuta:

```sh
netlify login
netlify deploy --prod --dir=. --functions=netlify/functions
```

Esta alternativa permite un despliegue manual que incluye la función. En cualquier caso, **comprueba que Netlify haya publicado la función**.

### Opción Netlify Drop

Si arrastras un proyecto completo a Netlify Drop mientras tienes sesión iniciada, puede ejecutar la preparación del proyecto. Como el soporte de funciones depende del tipo de despliegue, verifica después en **Functions** que aparece `sismos` y prueba su URL. Si no aparece, utiliza Git o la CLI.

## Funcionamiento y limitaciones

- El navegador consulta la ruta interna `/.netlify/functions/sismos`.
- Esa función descarga y lee el HTML público de la página original, transformando sus filas en registros estructurados. No se inventan eventos.
- La función mantiene una caché en memoria de hasta 3 minutos por instancia, para reducir las consultas al servidor de la Universidad.
- Si el IGC-UP no está disponible, puede mostrarse la última respuesta válida durante un máximo de 40 minutos por instancia de servidor (con aviso explícito). Si no hay ninguna lectura, aparece el error real, **nunca cifras simuladas**.
- La web no conserva eventos más antiguos que los que publica la fuente oficial; para crear un historial de meses sería necesaria una base de datos y una tarea de captura periódica.
- Las zonas y localidades se toman de la descripción reportada por el IGC-UP. Una localidad de referencia no equivale a una provincia ni significa que el epicentro esté dentro de ella.
- La información está expresada en hora oficial de Panamá (UTC−5).
- **Cartografía:** el mapa base y los archivos de Leaflet provienen de OpenStreetMap/unpkg; se usan solo para visualización. **Los registros sísmicos son exclusivamente del IGC-UP**. Si estos servicios cartográficos no están disponibles, se muestra un plano de coordenadas sin acudir a ninguna fuente sísmica adicional.
- El archivo HTML no obtiene datos reales al abrirse mediante `file://`. Primero debe publicarse con su función.
- El monitor es informativo, **no sustituye a los comunicados oficiales ni es una alerta temprana**. Los estados preliminares pueden cambiar.

## Pruebas

Prueba de interpretación de fechas, clasificación de regiones, lectura y deduplicación de filas:

```sh
npm test
```

Estas pruebas verifican el parser con una estructura HTML equivalente a la observada en la fuente. La disponibilidad y la estructura exacta del servidor remoto deben confirmarse al desplegar, ya que la fuente podría cambiarlas con el tiempo.

## Estructura

```
index.html
assets/style.css
assets/app.js
netlify/functions/sismos.js
netlify.toml
package.json
tests/parser.test.js
LEEME.md
```
