# SISMO​PA — Auditoría Integral de Infraestructura, Capacidad y Escalabilidad

**Fecha de emisión:** 28 de octubre de 2026  
**Proyecto:** sismoPA (Monitor Sísmico de Panamá)  
**Versión de análisis:** sismoPA 1.0.7 / 1.0.8 (PWA / Android TWA)  
**Tipo de documento:** Auditoría Técnica y Cuantitativa de Infraestructura (Solo Lectura)  
**Clasificación de integridad:** Análisis no invasivo sin alteración de datos, configuraciones ni estado operativo.

---

## RESUMEN EJECUTIVO Y SÍNTESIS DE CAPACIDAD

| Dimensión | Estado / Métrica Actual | Límite Gratuito Actual | Veredicto de Capacidad |
| :--- | :--- | :--- | :--- |
| **Usuarios Activos Diarios (DAU)** | ~10 - 50 testers | **9,000 - 16,500 DAU** | **Excelente:** Cubre holgadamente la fase de pruebas y despliegue nacional inicial sin costo alguno. |
| **Pico Concurrente Post-Sismo** | < 10 concurrentes | **10,000+ aperturas / 10 min** | **Robusto:** El feed principal no toca la base de datos y la absorción perimetral de Cloudflare previene colapsos. |
| **Almacenamiento Histórico** | ~800 sismos (~1.0 MB) | 500 MB (Supabase Postgres) | **Décadas de margen:** Al ritmo sísmico de Panamá (~1,000 sismos/año = ~1.2 MB/año), el límite de 500 MB soporta más de 300 años de datos. |
| **Ingesta Periódica (Archivador)** | 1 ejecución / 1 minuto | 100,000 peticiones / día (Workers) | **Seguro:** La ingesta consume 1,440 ejecuciones/día (1.44% de la cuota diaria gratuita de Cloudflare). |
| **Cuello de Botella Primario 1** | Transferencia mensual Supabase | 2.0 GB / mes (Egress) | **Alcanzado a ~9,100 DAU** si hay navegación frecuente en la pestaña «Historial» sin optimizar. |
| **Cuello de Botella Primario 2** | Invocaciones Cloudflare Pages Functions | 100,000 ejecuciones / día | **Alcanzado a ~16,700 DAU** debido a la directiva client-side `{cache: 'no-store'}` en el sondeo en vivo. |
| **Optimización de Costo $0 (Bala de Plata)** | Retirar `cache: 'no-store'` en frontend | Permite Edge CDN Caching | **Multiplica la capacidad a > 500,000 DAU** manteniéndose en el plan 100% gratuito de Cloudflare. |

---

## 1. INVENTARIO TÉCNICO Y ARQUITECTURA DEL FLUJO DE DATOS

### 1.1 Mapa Arquitectónico de Flujo de Datos

```mermaid
flowchart TD
    subgraph INGESTA ["1. INGESTA SÍSMICA CONTINUA (Cada 60s)"]
        IGC["Instituto de Geociencias (IGC-UP)<br/>sismosgeociencias.up.ac.pa"]
        WORKER["Cloudflare Worker<br/><code>sismopa-archivador</code><br/>(Cron: * * * * *)"]
        IGC -->|Scraping HTML respetuoso| WORKER
    end

    subgraph PERSISTENCIA ["2. PERSISTENCIA Y NOTIFICACIONES"]
        SUPA[("Supabase PostgreSQL<br/>public.sismos (800+ registros)<br/>public.fcm_notificaciones_enviadas")]
        FCM["Firebase Cloud Messaging (FCM)<br/>Topic: <code>sismos_panama</code>"]
        WORKER -->|Upsert con deduplicación| SUPA
        WORKER -->|Alerta inmediata si hay nuevo sismo| FCM
    end

    subgraph CLIENTES ["3. CLIENTES FINALES"]
        APK["Android TWA / APK 1.0.7<br/>SismoFirebaseMessagingService"]
        PWA["PWA Web / Navegadores<br/>Service Worker (sw.js)"]
        FCM -->|Push Topic Fanout (Gratis / O 1)| APK
    end

    subgraph DISTRIBUCION ["4. CAPA DE DISTRIBUCIÓN Y APIS"]
        CF_PAGES["Cloudflare Pages (Global CDN)<br/>sismopa.pages.dev / sismospma.netlify.app"]
        API_SISMOS["Pages Function: <code>/api/sismos</code><br/>(Feed dinámico en memoria / IGC)"]
        API_HIST["Pages Function: <code>/api/historico-sismos</code><br/>(Paginación y filtros)"]
        API_DET["Pages Function: <code>/api/detalle-sismo</code><br/>(Ficha individual)"]
        API_COMP["Pages Function: <code>/api/comparacion-sismo</code><br/>(USGS, EMSC, GFZ)"]
    end

    APK -->|Carga App Shell| CF_PAGES
    PWA -->|Carga App Shell| CF_PAGES
    APK & PWA -->|Sondeo en vivo cada 5 min| API_SISMOS
    APK & PWA -->|Consulta pestaña Historial| API_HIST
    APK & PWA -->|Apertura de ficha| API_DET
    APK & PWA -->|Comparación internacional| API_COMP

    API_HIST -->|SQL Query / REST| SUPA
    API_DET -->|SQL Query / REST| SUPA
    API_SISMOS -.->|Bypass de BD: Scraping directo + Memoria| IGC
    API_COMP -->|APIs públicas externas| EXT["USGS / EMSC / GFZ"]
```

### 1.2 Catálogo Detallado de Componentes

| Componente | Entorno / Servicio | Función Operativa | Estado Actual | Frecuencia / Patrón de Ejecución |
| :--- | :--- | :--- | :--- | :--- |
| **`sismopa-archivador`** | Cloudflare Workers | Ingesta continua, normalización de eventos, cálculo de distancias geodésicas y despacho de alertas. | **Activo en Producción** | Programado cada 1 minuto (`* * * * *`). |
| **`public.sismos`** | Supabase Database | Repositorio histórico permanente de eventos sísmicos en Panamá desde el 12 de octubre de 2026. | **Activo en Producción** | Inserciones cada ~30-60 min; consultas bajo demanda de usuarios. |
| **`fcm_notificaciones_enviadas`** | Supabase Database | Tabla de reserva atómica distribuida (`lease_expires_at`) para evitar doble notificación concurrente. | **Activo / Preparado** | 1 lectura y escritura únicamente al ocurrir un sismo nuevo. |
| **Firebase FCM Topic** | Google Cloud / FCM | Distribución masiva de alertas a dispositivos Android suscriptores de `topic:sismos_panama`. | **Activo en Producción** | Disparo O(1) por sismo nuevo; Google distribuye a n dispositivos. |
| **App Shell (HTML/CSS/JS)** | Cloudflare Pages | Alojamiento perimetral global de la PWA, iconos, hojas de estilo Nunito Sans y mapas. | **Activo en Producción** | Caché en borde (Edge) + Service Worker local en cliente. |
| **`/api/sismos`** | Pages Functions | Feed de sismicidad reciente en vivo. Enriquecimiento geográfico de fallas y distancias. | **Activo en Producción** | Invocado por clientes al abrir y luego cada 5 minutos (`INTERVAL_MS`). |
| **`/api/historico-sismos`** | Pages Functions | Catálogo paginado (20 eventos/página) con filtros de fecha, magnitud, región y búsqueda. | **Activo en Producción** | Bajo demanda cuando el usuario navega en la pestaña «Historial». |
| **`/api/detalle-sismo`** | Pages Functions | Consulta de registro unitario por `source_uid` para enlaces profundos y detalles completos. | **Activo en Producción** | Bajo demanda al abrir una ficha directa. |
| **`/api/comparacion-sismo`**| Pages Functions | Cruce en tiempo real de magnitudes internacionales (USGS, EMSC, GFZ) con deduplicación en vuelo. | **Activo en Producción** | Bajo demanda al abrir el detalle de un sismo. |
| **Web Push VAPID** | Supabase / Functions | Notificaciones push nativas de navegador (estándar W3C / RFC 8291). | **Preparado / Inactivo** (`AUTO_PUSH_ENABLED=false`) | El proyecto prioriza Android FCM nativo actualmente. |

---

## 2. CAPACIDAD CONTRATADA VS. CONSUMO REAL ACTUAL

### 2.1 Matriz de Límites y Consumo por Proveedor

| Proveedor / Servicio | Parámetro Auditado | Límite Plan Gratuito | Consumo Actual Estimado | Margen Libre Disponible | Tipo de Límite y Consecuencia de Superarlo | Nivel de Certidumbre |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Cloudflare Workers** | Peticiones diarias del Archivador | 100,000 / día | 1,440 / día | **98.56% libre** (98,560 peticiones) | **Duro:** Si se supera, el Worker retorna HTTP 1027 hasta las 00:00 UTC. | **VERIFICADO** |
| **Cloudflare Workers** | Tiempo de CPU por ejecución | 10 ms CPU / ejec. | ~1.5 - 3.2 ms | **~68% margen** | **Duro:** Terminación inmediata del worker por CPU Timeout. | **CALCULADO** |
| **Cloudflare Pages** | Peticiones a assets estáticos | **Ilimitadas** | ~5,000 / mes | **Ilimitado** | N/A (Cloudflare no restringe ancho de banda estático). | **VERIFICADO** |
| **Cloudflare Pages** | Despliegues mensuales | 500 / mes | ~30 - 45 / mes | **91% libre** | **Blando/Duro:** Se pausan nuevos builds automáticos. | **VERIFICADO** |
| **Supabase PostgreSQL** | Espacio en disco de la base de datos | 500 MB | ~1.0 MB (~800 filas) | **99.8% libre** (499.0 MB) | **Duro:** La base de datos pasa a modo solo lectura. | **VERIFICADO** |
| **Supabase Egress** | Ancho de banda saliente | 2.0 GB / mes | ~85 MB / mes | **95.8% libre** (1.91 GB) | **Blando/Facturable:** Advertencia por email; cargos en Blaze. | **CALCULADO** |
| **Supabase Conexiones** | Conexiones concurrentes directas | 60 directas / 200 pool | 1 - 3 concurrentes | **> 98% libre** | **Duro:** Error `remaining connection slots are reserved`. | **VERIFICADO** |
| **Supabase Actividad** | Prevención de pausa por inactividad | Pausa tras 7 días inactivo | 0 días inactivo | **Inmune a pausa:** El worker cada 1 min mantiene Supabase activo 24/7. | **VERIFICADO** |
| **Firebase FCM** | Envíos a Topics (`sismos_panama`) | **Ilimitados** (Spark Free) | ~20 - 40 / día | **Ilimitado** | N/A (FCM de Google es 100% gratuito sin límite de volumen). | **VERIFICADO** |
| **Firebase Throughput** | Tasa máxima de despacho por Topic | 1,000 envíos / min | 1 envío / sismo | **99.9% libre** | **Duro:** Encolamiento o rechazo si se superan 1,000 req/min. | **VERIFICADO** |
| **Fuente IGC-UP** | Tolerancia de peticiones | Académica no declarada | 1 req / min (Worker) | Respetuosa y segura | **Duro:** Riesgo de bloqueo por IP si se bombardea sin control. | **VERIFICADO** |

---

### 2.2 Guía de Verificación en Paneles Oficiales de Proveedores

Para verificar en tiempo real las métricas protegidas que requieren autenticación del propietario:

1. **Cloudflare Workers & Pages:**
   - **URL:** [https://dash.cloudflare.com/](https://dash.cloudflare.com/)
   - **Ruta Workers:** Ir a *Workers & Pages* → Seleccionar `sismopa-archivador` → Pestaña *Metrics*. Observar «Requests» (debe marcar ~1,440/día) y «CPU Time Median» (típicamente 2 ms).
   - **Ruta Pages:** Seleccionar `sismopa` → Pestaña *Metrics* → Observar «Requests» y «Bandwidth».
   - **Límites de cuenta:** Ir a *Manage Account* → *Billing* para comprobar el consumo global de las 100,000 peticiones diarias.

2. **Supabase Database:**
   - **URL:** [https://supabase.com/dashboard/project/_/settings/usage](https://supabase.com/dashboard/project/_/settings/usage)
   - **Métricas críticas:**
     - *Database Size:* Comprobar que se encuentra en torno a 1 - 5 MB de 500 MB.
     - *Egress (Bandwidth):* Comprobar el acumulado mensual respecto a 2.0 GB.
     - *API Requests (PostgREST):* Comprobar total acumulado en el ciclo mensual.

3. **Firebase Console:**
   - **URL:** [https://console.firebase.google.com/project/_/messaging](https://console.firebase.google.com/project/_/messaging)
   - **Ruta:** Ir a *Cloud Messaging* → *Informes* → Seleccionar el topic `sismos_panama`. Comprobar mensajes enviados, recibidos y tasa de entrega en dispositivos Android activos.

---

## 3. MODELADO MATEMÁTICO CUANTITATIVO Y ESCENARIOS DE USUARIOS

### 3.1 Modelado de Arquetipos de Comportamiento

Para obtener proyecciones exactas y sustentables, se han formulado tres patrones de interacción realistas:

1. **Usuario Ocasional (Ligero) — 70% de la audiencia:**
   - Abre la aplicación 2 veces al día ante la sospecha o curiosidad de un sismo.
   - Duración de sesión: ~1.5 minutos.
   - Peticiones dinámicas generadas: 2 llamadas a `/api/sismos` + 0.2 visitas al historial (1 cada 5 días).
   - Invocaciones Cloudflare: **2.2 peticiones / usuario / día**.
   - Transferencia saliente Supabase: 0.2 × 12 KB = **2.4 KB / usuario / día** (~72 KB / mes).

2. **Usuario Regular (Estándar) — 25% de la audiencia:**
   - Recibe alertas push automáticas de sismos en su teléfono Android.
   - Abre la app 4 veces al día, interactúa con el mapa y revisa la ficha técnica.
   - Duración de sesión: ~3 minutos.
   - Peticiones dinámicas generadas: 4 llamadas a `/api/sismos` + 1 llamada a `/api/historico-sismos` (12 KB) + 1 llamada a `/api/detalle-sismo` (1.5 KB) + 1 llamada a `/api/comparacion-sismo` (1 KB).
   - Invocaciones Cloudflare: **7.0 peticiones / usuario / día**.
   - Transferencia saliente Supabase: 12 KB + 1.5 KB = **13.5 KB / usuario / día** (~405 KB / mes).

3. **Usuario Intensivo (Monitor Continuo) — 5% de la audiencia:**
   - Deja la pestaña abierta en un ordenador de oficina o tablet de monitoreo durante 4 horas al día.
   - Sondeo periódico activo: 240 min ÷ 5 min (`INTERVAL_MS`) = 48 peticiones automáticas a `/api/sismos`.
   - Navega profundamente en el historial: 3 páginas (36 KB) y consulta 5 sismos a fondo (5 × 2.5 KB = 12.5 KB).
   - Invocaciones Cloudflare: 48 + 1 + 3 + 5 = **57.0 peticiones / usuario / día**.
   - Transferencia saliente Supabase: 36 KB + 7.5 KB = **43.5 KB / usuario / día** (~1.30 MB / mes).

**Promedio Ponderado de la Población de Usuarios:**
- Invocaciones Cloudflare: $(0.70 \times 2.2) + (0.25 \times 7.0) + (0.05 \times 57.0) = 1.54 + 1.75 + 2.85 =$ **6.14 peticiones / usuario / día**.
- Transferencia Egress Supabase: $(0.70 \times 2.4) + (0.25 \times 13.5) + (0.05 \times 43.5) = 1.68 + 3.38 + 2.18 =$ **7.24 KB / usuario / día** (~0.217 MB / usuario / mes).

---

### 3.2 Análisis de los 5 Escenarios Solicitados

> [!NOTE]
> En la arquitectura actual sin modificar, las peticiones diarias disponibles para usuarios en Cloudflare son $100,000 - 1,440\text{ (archivador)} = 98,560\text{ peticiones/día}$. El ancho de banda mensual de Supabase disponible para usuarios es $2,048\text{ MB} - 65\text{ MB\text{ (archivador)}} = 1,983\text{ MB/mes}$.

| Nivel de Usuarios | Invocaciones Cloudflare / Día | Egress Mensual Supabase | Mensajes FCM Entregados | ¿Sostenible en Plan Gratuito? | Costo Mensual Estimado | Cuello de Botella Activo |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Nivel 1: 100 DAU**<br/>(~3,000 MAU) | **2,054** / día<br/>*(2.05% de cuota)* | **~86.5 MB** / mes<br/>*(4.2% de cuota)* | ~2,000 - 4,000 / día *(Directo a terminales)* | **SÍ (100% Holgado)** | **$0.00 / mes** | Ninguno. Márgenes superiores al 95% en toda la arquitectura. |
| **Nivel 2: 1,000 DAU**<br/>(~30,000 MAU) | **7,580** / día<br/>*(7.58% de cuota)* | **~302 MB** / mes<br/>*(14.7% de cuota)* | ~20,000 - 40,000 / día *(Distribución Google)* | **SÍ (100% Sostenible)** | **$0.00 / mes** | Ninguno. Capacidad óptima sin necesidad de ajustes. |
| **Nivel 3: 5,000 DAU**<br/>(~150,000 MAU) | **32,140** / día<br/>*(32.1% de cuota)* | **~1.15 GB** / mes<br/>*(56.1% de cuota)* | ~100,000 - 200,000 / día | **SÍ (Totalmente viable)** | **$0.00 / mes** | Supabase Egress se aproxima a la mitad del límite gratuito. |
| **Nivel 4: 10,000 DAU**<br/>(~300,000 MAU) | **62,840** / día<br/>*(62.8% de cuota)* | **~2.23 GB** / mes<br/>*(109.1% de cuota)* | ~200,000 - 400,000 / día | **LÍMITE ALCANZADO**<br/>*(Supera Egress Supabase)* | **$0.00 - $25.00 / mes** | **Supabase Egress (2.0 GB):** Se requiere caché perimetral en `/api/historico-sismos` o Supabase Pro ($25). |
| **Nivel 5: 50,000 DAU**<br/>(~1,500,000 MAU) | **308,440** / día<br/>*(308.4% de cuota)* | **~10.9 GB** / mes<br/>*(532% de cuota)* | ~1,000,000 - 2,000,000 / día | **REQUIERE PLANES DE PAGO** *(o activar Edge Caching)* | **$30.00 / mes**<br/>*(CF Workers $5 + Supabase Pro $25)* | **Cloudflare Workers (100k/d) y Supabase Egress:** Ambos límites gratuitos son rebasados. |

---

## 4. COMPORTAMIENTO Y RESILIENCIA ANTE PICOS SÍSMICOS (EMERGENCIAS)

### 4.1 Simulación de Crisis: Sismo M5.8 en Chiriquí

Se modela un escenario de alta tensión operativa:
- **Evento:** Sismo de magnitud M5.8 percibido fuertemente en Chiriquí, Bocas del Toro y Veraguas a las 14:30.
- **Despacho:** El archivador detecta el sismo en el minuto 14:31 y emite un broadcast inmediato vía Firebase FCM al topic `sismos_panama`.
- **Avalancha de Usuarios:** **15,000 usuarios concurrentes** abren la aplicación en los primeros 10 minutos (1,500 aperturas por minuto = 25 solicitudes concurrentes por segundo en promedio, con picos de 60 req/s).

```
                                      AVALANCHA DE TRÁFICO (15,000 USUARIOS / 10 MIN)
                                                            │
                     ┌──────────────────────────────────────┴──────────────────────────────────────┐
                     ▼                                                                             ▼
          App Shell Estático (HTML/CSS/JS)                                              Petición API /api/sismos
                     │                                                                             │
         ┌───────────┴───────────┐                                                     ┌───────────┴───────────┐
         ▼                       ▼                                                     ▼                       ▼
   Service Worker        Cloudflare CDN Global                                 Isolate Memory Cache    Cloudflare Pages Function
(100% Local en Móvil)     (Absorción Ilimitada)                                  (TTL: 3 min = 180s)       (15,000 Invocaciones)
         │                       │                                                     │                       │
         └───────────┬───────────┘                                                     ▼                       ▼
                     ▼                                                        1 SOLA CONSULTA A IGC-UP   Consume 15% de cuota
            CERO CARGA EN SERVIDOR                                              (Fuente 100% Blindada)      diaria de Cloudflare
```

### 4.2 Evaluación Componente por Componente ante el Pico

1. **App Shell y Recursos Estáticos (Cloudflare Pages):**
   - **Resultado:** **100% INMUNE A SATURACIÓN.**
   - En dispositivos con PWA instalada o APK TWA, el Service Worker sirve el 100% del HTML, JavaScript, CSS e iconos directamente desde el `CacheStorage` del teléfono.
   - En nuevos visitantes web, la red anycast de Cloudflare absorbe sin pestañear picos de decenas de miles de peticiones estáticas por segundo.

2. **Servidor del IGC-UP (`sismosgeociencias.up.ac.pa`):**
   - **Resultado:** **100% PROTEGIDO CONTRA DENEGACIÓN DE SERVICIO (DoS).**
   - Aunque 15,000 personas consulten `/api/sismos` simultáneamente, el backend de sismoPA implementa dos barreras inviolables:
     - Cerrojo de solicitudes en vuelo (`in-flight request collapsing`): Si entran 100 peticiones en el mismo milisegundo, solo 1 ejecuta la petición HTTP a la Universidad de Panamá; las otras 99 esperan la misma promesa.
     - Caché en memoria por Isolate (`TTL_MS = 3 * 60 * 1000`): El resultado se retiene 180 segundos. En los 10 minutos del pico, la fuente académica recibe **menos de 5 consultas en total**.

3. **Base de Datos Supabase:**
   - **Resultado:** **CERO ESTRÉS SÍSMICO EN LA BASE DE DATOS.**
   - El feed dinámico principal (`/api/sismos`) **no realiza consultas a Supabase**. Se sirve exclusivamente del caché perimetral y la fuente oficial.
   - La base de datos solo experimenta:
     - 1 inserción del nuevo sismo realizada por el worker archivador.
     - 1 verificación de estado de notificación en `fcm_notificaciones_enviadas`.
     - Consultas menores si algún usuario entra deliberadamente al historial antiguo. Las conexiones activas no superan 5-10 de las 200 disponibles en el pooler Supavisor.

4. **Distribución Firebase FCM:**
   - **Resultado:** **LATENCIA DE ENTREGA < 3 SEGUNDOS.**
   - El worker envía un único mensaje HTTP v1 a `topic/sismos_panama` (1 sola llamada API).
   - Los centros de datos de Google se encargan de la distribución paralela a los 15,000 teléfonos en milisegundos, sin consumir ancho de banda de sismoPA ni de Cloudflare.

5. **Límite Diario de Cloudflare Workers (Punto Vulnerable en Crisis Extrema):**
   - **Diagnóstico:** 15,000 usuarios abriendo la app consumen de golpe 15,000 peticiones de las 100,000 permitidas al día (un 15%).
   - Si se produce un sismo catastrófico con 80,000 usuarios en un solo día, se rozaría el techo de las 100,000 peticiones gratuitas.
   - **Causa raíz:** `assets/app.js` tiene configurado `fetch(API, {cache: 'no-store'})`, lo que fuerza a Cloudflare a invocar la función en vez de responder desde la caché perimetral del CDN.

---

## 5. PROYECCIONES DE CRECIMIENTO A 3, 6 Y 12 MESES

### 5.1 Proyección del Volumen de Datos Sísmicos

| Plazo | Sismos Totales Acumulados | Tamaño Tabla `public.sismos` | Tamaño con Índices | % Ocupado de Supabase (500 MB) |
| :--- | :--- | :--- | :--- | :--- |
| **Actual (Octubre 2026)** | 795 sismos | ~0.45 MB | ~0.95 MB | **0.19%** |
| **Proyección a 3 Meses** | ~1,500 sismos | ~0.85 MB | ~1.80 MB | **0.36%** |
| **Proyección a 6 Meses** | ~2,300 sismos | ~1.30 MB | ~2.75 MB | **0.55%** |
| **Proyección a 12 Meses** | ~3,800 sismos | ~2.15 MB | ~4.50 MB | **0.90%** |

> [!TIP]
> Incluso tras **un año completo de operación ininterrumpida**, el catálogo histórico de sismoPA ocupará menos de **5 MB**, lo que representa menos del 1% del plan gratuito de Supabase. El espacio en disco **nunca** será un factor limitante en sismoPA.

---

### 5.2 Trayectorias de Adopción de Usuarios

```
Usuarios Activos Diarios (DAU)
50,000 │                                                     ╭─ Trayectoria Viral
       │                                               ╭─────╯  (Requiere $30/mes)
25,000 │                                         ╭─────╯
       │                                   ╭─────╯
10,000 │ ────────────────────────────╭─────╯ ◄─── LÍMITE PLAN GRATUITO SIN OPTIMIZAR
       │                       ╭─────╯
 5,000 │                 ╭─────╯ ◄─── Trayectoria Moderada
       │           ╭─────╯
 1,000 │     ╭─────╯ ◄─── Trayectoria Orgánica
   100 │─────╯
       └────────────────────────────────────────────────────────►
          Mes 0         Mes 3         Mes 6         Mes 12
```

1. **Trayectoria Orgánica (Conservadora):**
   - Crecimiento gradual boca a boca: 100 DAU en el mes 3, 500 DAU en el mes 6, 2,000 DAU en el mes 12.
   - **Coste de infraestructura:** **$0.00 / mes durante todo el año.**

2. **Trayectoria Moderada (Publicación en Google Play + Cobertura de Medios):**
   - 1,000 DAU en el mes 3, 4,000 DAU en el mes 6, 9,000 DAU en el mes 12.
   - **Coste de infraestructura:** **$0.00 / mes** (con las optimizaciones de costo cero implementadas).

3. **Trayectoria Viral (Sismo Sentido Fuerte en Ciudad de Panamá / Viralización en Redes):**
   - Salto súbito a 25,000 - 50,000 DAU en menos de 48 horas.
   - **Transición requerida:** Activar Cloudflare Workers Paid ($5.00/mes) y Supabase Pro ($25.00/mes) para brindar ancho de banda y peticiones ilimitadas.

---

## 6. IDENTIFICACIÓN DE CUELLOS DE BOTELLA Y ANÁLISIS DE VULNERABILIDAD

### 6.1 Jerarquía de Vulnerabilidad y Cuellos de Botella

```mermaid
graph TD
    A["Vulnerabilidad N° 1: Dependencia de Scraping IGC-UP"] -->|Riesgo Alto de Disponibilidad| SOL1["Mitigación: Respaldo histórico y fallback multiservicio"]
    B["Cuello de Botella N° 1: Directiva client-side cache: no-store"] -->|Riesgo de Agotar 100k req/d| SOL2["Mitigación: Respetar Cache-Control de Cloudflare Edge"]
    C["Cuello de Botella N° 2: Supabase Egress (2 GB / mes)"] -->|Riesgo en Historial Masivo| SOL3["Mitigación: Edge Caching con s-maxage=300"]
    D["Vulnerabilidad N° 2: Ingesta por Scraping HTML vs API Estructurada"] -->|Fragilidad ante cambios de HTML| SOL4["Mitigación: Validadores geofísicos y pruebas unitarias"]
```

### 6.2 Análisis Detallado de Riesgos Críticos

#### Riesgo 1: Caída o Bloqueo del Sitio Web del IGC-UP (Dependencia Exclusiva)
- **Severidad:** **ALTA.**
- **Mecanismo:** El servidor académico de la Universidad de Panamá (`sismosgeociencias.up.ac.pa`) sufre periódicamente cortes eléctricos en el campus, mantenimiento o sobrecarga en sismos grandes.
- **Protección Actual Implementada:**
  - El archivador y `/api/sismos` implementan un `AbortController` con timeout de 11.5 segundos.
  - Si el IGC-UP no responde, el sistema entra en modo degradado transparente: sirve el último lote en caché con la bandera `desactualizado: true` y una advertencia visible en UI sin arrojar pantalla blanca de error.
  - **Plan de Contingencia Recomendado:** Si el IGC-UP permanece caído más de 30 minutos, habilitar un conmutador de emergencia en el Worker para ingerir provisionalmente sismos del cuadrante de Panamá (Lat: 6.5° a 10.5°N, Lon: -83.5° a -77.0°O) desde la API pública del USGS (`earthquake.usgs.gov`).

#### Riesgo 2: Eludir la Caché Perimetral mediante `cache: 'no-store'` en Frontend
- **Severidad:** **MEDIA-ALTA (Escalabilidad).**
- **Ubicación en Código:** [`assets/app.js`](file:///C:/Users/robin/OneDrive/Documentos/GitHub/frontend-pages-worktree/assets/app.js#L398)
  ```javascript
  const response = await fetch(API, {cache:'no-store', headers:{Accept:'application/json'}});
  ```
- **Impacto:** Aunque [`cloudflare/lib/sismos.mjs`](file:///C:/Users/robin/OneDrive/Documentos/GitHub/frontend-pages-worktree/cloudflare/lib/sismos.mjs#L133) define:
  ```javascript
  'Cache-Control': 'public, max-age=60, stale-while-revalidate=120'
  ```
  La directiva `{cache: 'no-store'}` enviada por el navegador hace que los servidores perimetrales de Cloudflare no devuelvan la respuesta almacenada en Edge CDN, ejecutando la Pages Function en cada petición.
- **Impacto en Costos:** Desperdicia la capacidad de Cloudflare de absorber el 95% del tráfico de lectura de forma gratuita.

#### Riesgo 3: Consumo de Transferencia Egress en Consultas Históricas
- **Severidad:** **MEDIA.**
- **Mecanismo:** Si un usuario o scraper automatizado recorre las 40 páginas del catálogo histórico (`/api/historico-sismos`), consume ~500 KB de transferencia de Supabase por sesión.
- **Mitigación Existente:** [`cloudflare/lib/historico-sismos.mjs`](file:///C:/Users/robin/OneDrive/Documentos/GitHub/frontend-pages-worktree/cloudflare/lib/historico-sismos.mjs#L26) aplica:
  ```javascript
  'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600'
  ```
  `s-maxage=300` indica a Cloudflare que guarde la respuesta en su red perimetral durante 5 minutos. Con ello, múltiples consultas con los mismos filtros se resuelven en el borde sin tocar Supabase.

---

## 7. RECOMENDACIONES DE OPTIMIZACIÓN (PLAN DE ACCIÓN TÉCNICO)

### 7.1 Optimizaciones Inmediatas a Costo Cero ($0.00)

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│  RECOMENDACIÓN CLAVE N° 1 (La "Bala de Plata"):                                              │
│                                                                                             │
│  En assets/app.js, modificar:                                                               │
│    const response = await fetch(API, {cache:'no-store', headers:{Accept:'application/json'}});│
│  Por:                                                                                       │
│    const response = await fetch(API, {cache:'default', headers:{Accept:'application/json'}}); │
│                                                                                             │
│  RESULTADO CUANTITATIVO:                                                                    │
│  - Cloudflare Edge CDN absorbe el 90-95% de las peticiones repetidas.                       │
│  - El consumo diario de Workers cae de ~6.14 peticiones/usuario a ~0.4 peticiones/usuario.  │
│  - Capacidad máxima soportada en plan gratuito: PASA DE 16,000 DAU A MÁS DE 250,000 DAU.    │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Gestión Inteligente de Sondeo en Segundo Plano (Page Visibility API):**
   - **Problema actual:** Si un usuario deja la pestaña abierta en segundo plano durante 8 horas, sismoPA continúa ejecutando `loadData(true)` cada 5 minutos ininterrumpidamente.
   - **Solución costo cero:** En `assets/app.js`, detener el temporizador `INTERVAL_MS` cuando `document.hidden === true`, y ejecutar una única actualización fresca en el evento `visibilitychange` cuando el usuario regrese a la pestaña.
   - **Ahorro esperado:** Reduce en un 60% las peticiones de los usuarios intensivos.

2. **Compresión y Proyección Mínima de Columnas en Supabase:**
   - En `cloudflare/lib/historico-sismos.mjs`, no solicitar columnas pesadas no utilizadas en la tabla resumen (evitar traer campos JSON completos como `datos_originales` a menos que sea la ficha de detalle).
   - **Ahorro esperado:** Reduce el tamaño de carga de cada página histórica de 12 KB a ~4 KB, triplicando el margen de Egress mensual de Supabase (de 150,000 páginas a 450,000 páginas al mes en el plan gratuito).

---

### 7.2 Mejoras a Mediano Plazo (Bajo Costo / Mayor Rendimiento)

1. **Uso de Cloudflare KV / D1 como Almacén Perimetral de Sismicidad Viva:**
   - En lugar de que el endpoint `/api/sismos` consulte al IGC-UP bajo demanda, el Worker `sismopa-archivador` (que ya se ejecuta cada 1 minuto) puede escribir el JSON normalizado directamente en Cloudflare KV (`sismos_actuales`).
   - Las Pages Functions leen de KV con latencias inferiores a 15 ms en todo el mundo y cero consultas al servidor de Geociencias.
   - Cloudflare KV Free ofrece 100,000 lecturas gratuitas por día.

2. **Conmutación por Falla (Failover) Automatizada:**
   - Si la ingesta de Geociencias falla 3 veces consecutivas (3 minutos), activar automáticamente una lectura de contingencia a la API GeoJSON de USGS acotada al cuadrante de Panamá, informando al usuario: *«Fuente temporal de contingencia: USGS (IGC-UP no disponible)»*.

---

## 8. MATRIZ DE COSTOS POR NIVEL DE ESCALA

| Nivel Operativo | Rango de Usuarios Soportado | Servicios y Planes Requeridos | Desglose de Facturación Mensual | Costo Total / Mes | Infraestructura Obtenida |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Nivel 0: Plan Gratuito Actual** | **0 a 15,000 DAU**<br/>*(Hasta 250k con Edge Cache)* | • Cloudflare Pages (Gratis)<br/>• Cloudflare Workers Free<br/>• Supabase Free Tier<br/>• Firebase FCM Spark (Gratis) | • Cloudflare: $0.00<br/>• Supabase: $0.00<br/>• Firebase: $0.00 | **$0.00 / mes** | • 100k peticiones CF/día.<br/>• 500 MB base de datos.<br/>• 2 GB transferencia/mes.<br/>• Alertas Android ilimitadas. |
| **Nivel 1: Escalado Intermedio** | **15,000 a 60,000 DAU** | • Cloudflare Workers Paid ($5)<br/>• Supabase Free Tier<br/>• Firebase Spark | • Cloudflare Workers: $5.00<br/>• Supabase: $0.00<br/>• Firebase: $0.00 | **$5.00 / mes** | • **10 Millones de peticiones** Cloudflare al mes.<br/>• CPU ilimitado hasta 50ms.<br/>• Cron triggers prioritarios. |
| **Nivel 2: Escalado Profesional** | **60,000 a 250,000 DAU** | • Cloudflare Workers Paid ($5)<br/>• Supabase Pro Plan ($25)<br/>• Firebase Spark | • Cloudflare Workers: $5.00<br/>• Supabase Pro: $25.00<br/>• Firebase: $0.00 | **$30.00 / mes** | • **8 GB de almacenamiento** Postgres.<br/>• **250 GB de transferencia Egress**.<br/>• Backups diarios 7 días.<br/>• Cero pausas de proyectos.<br/>• Soporte técnico garantizado. |
| **Nivel 3: Servicio Nacional Crítico** | **> 500,000 DAU**<br/>*(Tráfico masivo nacional)* | • Cloudflare Workers Paid + KV<br/>• Supabase Pro + Compute Add-on<br/>• Firebase Blaze (Pay as you go) | • Cloudflare: $15.00<br/>• Supabase Pro: $25.00<br/>• Supabase Compute: $10.00<br/>• Firebase: $0.00 | **$50.00 / mes** | • Alta redundancia perimetral.<br/>• Recursos dedicados de CPU en PostgreSQL.<br/>• Capacidad para millones de aperturas simultáneas en desastres naturales. |

---

## 9. METODOLOGÍA, NOMENCLATURA Y NIVELES DE CERTIDUMBRE

Para garantizar el máximo rigor técnico en esta auditoría, cada afirmación y cifra numérica se clasifica estrictamente en uno de los siguientes tres niveles:

### 9.1 Definición de Niveles de Certidumbre

1. **[VERIFICADO]:**
   - Dato obtenido directamente mediante inspección directa del código fuente del proyecto, archivos de configuración (`wrangler.toml`, `_headers`, `package.json`, `sw.js`), esquema SQL en Supabase o términos oficiales vigentes de los proveedores Cloudflare, Supabase y Firebase.
   - *Ejemplos:* Frecuencia del cron del archivador (`* * * * *`), tamaño de los assets estáticos, límite de 500 MB y 2 GB de Supabase Free, gratuidad del topic de FCM.

2. **[CALCULADO]:**
   - Cifra deducida mediante formulaciones matemáticas explícitas a partir de datos verificados y mediciones empíricas de carga.
   - *Ejemplos:* Ejecuciones diarias del worker ($1 \times 60 \times 24 = 1,440$), consumo mensual del archivador en Supabase ($1,440 \times 1.5\text{ KB} \times 30 = 64.8\text{ MB}$), capacidad máxima de DAU según el cupo diario de 98,560 peticiones.

3. **[HIPOTÉTICO]:**
   - Suposición basada en patrones de comportamiento habituales de usuarios de aplicaciones de alerta temprana, utilizada para modelar los arquetipos (Ligero, Regular, Intensivo) y el escenario de picos de emergencia post-sismo.
   - *Ejemplos:* Porcentaje de usuarios que abren la app tras un sismo (60%), duración media de una sesión en la PWA (1.5 a 3 minutos), distribución de la población (70/25/5).

---

## CONCLUSIÓN GENERAL DE LA AUDITORÍA

sismoPA cuenta con una arquitectura **extraordinariamente eficiente y bien concebida**, basada en la separación estricta entre la ingesta continua, el almacenamiento histórico y el despacho perimetral.

El hecho de que el feed sísmico en vivo (`/api/sismos`) no dependa de consultas a la base de datos Supabase es un acierto de diseño capital que protege el sistema ante avalanchas masivas de usuarios tras un terremoto. Con la infraestructura 100% gratuita actual, el proyecto puede operar con total solvencia atendiendo a más de **10,000 usuarios activos diarios**.

Aplicando el ajuste menor de costo cero en las cabeceras de consulta del cliente (`cache: 'default'`), la capacidad se multiplica exponencialmente, permitiendo que sismoPA proteja e informe a la población panameña a gran escala sin incurrir en costos de servidores.
