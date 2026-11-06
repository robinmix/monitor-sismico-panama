import { handler } from '../../cloudflare/lib/historico-sismos.mjs';
import { eventoNetlify, respuestaPages } from '../../cloudflare/adaptador.mjs';

const PROD_ENDPOINT = 'https://sismospma.netlify.app/api/historico-sismos';

export async function onRequest(context) {
  // 1. Métodos autorizados exclusivamente de solo lectura
  if (!['GET', 'OPTIONS'].includes(context.request.method)) {
    return Response.json(
      { ok: false, error: 'Método no permitido. Solo se admiten solicitudes GET u OPTIONS.' },
      { status: 405, headers: { Allow: 'GET, OPTIONS' } }
    );
  }
  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept'
      }
    });
  }

  const hasSupabaseCreds = Boolean(context.env?.SUPABASE_URL && context.env?.SUPABASE_SECRET_KEY);

  // Identificación explícita y no ambigua del entorno Preview
  const branchName = context.env?.CF_PAGES_BRANCH;
  const isExplicitPreview = typeof branchName === 'string' &&
    branchName.length > 0 &&
    branchName !== 'main' &&
    branchName !== 'master';

  // 2. Si las credenciales de Supabase están configuradas, o si el entorno NO está
  //    explícitamente identificado como Preview (p. ej. Producción o entorno desconocido):
  //    Ejecutar siempre el manejador directo. Si faltan credenciales en un entorno no-preview,
  //    falla de forma segura y detectable sin activar el respaldo.
  if (!isExplicitPreview || hasSupabaseCreds) {
    const resultado = await handler(eventoNetlify(context.request), {}, { env: context.env });
    return respuestaPages(resultado);
  }

  // 3. Activar proxy de respaldo EXCLUSIVAMENTE cuando el entorno esté identificado
  //    explícitamente como Preview y no disponga de credenciales directas de Supabase.
  try {
    const reqUrl = new URL(context.request.url);
    const allowedParams = [
      'anio', 'year', 'mes', 'month', 'include_events', 'eventos',
      'page', 'pagina', 'limit', 'limite', 'order', 'orden',
      'region', 'estado', 'min_mag', 'max_mag', 'min_prof', 'max_prof',
      'desde', 'from', 'hasta', 'to', 'sort', 'search', 'q', 'buscar', 'include_stats', 'provincia', 'province', 'distrito', 'district'
    ];
    const safeSearchParams = new URLSearchParams();
    for (const [key, value] of reqUrl.searchParams.entries()) {
      if (allowedParams.includes(key.toLowerCase())) {
        safeSearchParams.set(key, value);
      }
    }

    const targetUrl = `${PROD_ENDPOINT}?${safeSearchParams.toString()}`;
    const reqProv = safeSearchParams.get('provincia') || safeSearchParams.get('province');
    const reqDist = safeSearchParams.get('distrito') || safeSearchParams.get('district');
    const isStatsOnly = safeSearchParams.get('include_events') === 'false';

    let fetchUrl = targetUrl;
    // En entorno de preview si se filtra por territorio y sólo se piden stats, pedimos eventos para calcular stats reales del territorio
    if ((reqProv || reqDist) && isStatsOnly) {
      const statsParams = new URLSearchParams(safeSearchParams);
      statsParams.set('include_events', 'true');
      statsParams.set('limit', '500');
      fetchUrl = `${PROD_ENDPOINT}?${statsParams.toString()}`;
    }

    const prodRes = await fetch(fetchUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'sismoPA-Cloudflare-Preview-Proxy/1.0'
      }
    });

    if (!prodRes.ok) {
      const errText = await prodRes.text();
      return new Response(errText, { status: prodRes.status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
    }

    let data = await prodRes.json().catch(() => null);
    if (data && (reqProv || reqDist) && Array.isArray(data.eventos)) {
      const pNorm = (reqProv || '').toLowerCase();
      const dNorm = (reqDist || '').toLowerCase();

      const filteredEvents = data.eventos.filter(ev => {
        if (pNorm === 'maritimo' || pNorm === 'marítimo') {
          return ev.geo_tipo === 'MARITIMO';
        }
        if (pNorm) {
          const evProv = (ev.geo_provincia || ev.geo_comarca || '').toLowerCase();
          if (!evProv) return false;
          if (!evProv.includes(pNorm) && !pNorm.includes(evProv)) return false;
        }
        if (dNorm) {
          const evDist = (ev.geo_distrito || '').toLowerCase();
          if (!evDist) return false;
          if (!evDist.includes(dNorm) && !dNorm.includes(evDist)) return false;
        }
        return true;
      });

      // Recalcular métricas para el subconjunto territorial
      const totalFiltered = filteredEvents.length;
      let magSum = 0, magCount = 0, magMax = null, magMin = null;
      let profSum = 0, profCount = 0;
      let countM3 = 0, count3a39 = 0, count4a49 = 0, countM5 = 0;
      const distMensual = {}, distDiaria = {}, regCounts = {};

      for (const ev of filteredEvents) {
        const m = Number(ev.magnitud);
        if (!isNaN(m)) {
          magSum += m; magCount++;
          if (magMax === null || m > magMax) magMax = m;
          if (magMin === null || m < magMin) magMin = m;
          if (m < 3.0) countM3++;
          else if (m < 4.0) count3a39++;
          else if (m < 5.0) count4a49++;
          else countM5++;
        }
        const p = Number(ev.profundidad_km || ev.profundidad);
        if (!isNaN(p) && p >= 0) {
          profSum += p; profCount++;
        }
        if (ev.fecha) {
          const ym = ev.fecha.slice(0, 7);
          distMensual[ym] = (distMensual[ym] || 0) + 1;
          distDiaria[ev.fecha] = (distDiaria[ev.fecha] || 0) + 1;
        }
        const reg = ev.geo_distrito || ev.geo_provincia || ev.geo_zona_maritima || 'Sin clasificar';
        regCounts[reg] = (regCounts[reg] || 0) + 1;
      }

      data.filtros_aplicados = data.filtros_aplicados || {};
      data.filtros_aplicados.provincia = reqProv;
      data.filtros_aplicados.distrito = reqDist;

      data.estadisticas = {
        total: totalFiltered,
        menor_3: countM3,
        entre_3_y_3_9: count3a39,
        entre_4_y_4_9: count4a49,
        mayor_igual_5: countM5,
        mag_max: magMax,
        mag_min: magMin,
        mag_promedio: magCount > 0 ? Number((magSum / magCount).toFixed(2)) : null,
        prof_promedio: profCount > 0 ? Number((profSum / profCount).toFixed(1)) : null,
        por_magnitud: { menor_3: countM3, entre_3_y_3_9: count3a39, entre_4_y_4_9: count4a49, mayor_igual_5: countM5 },
        magnitud: { max: magMax, min: magMin, promedio: magCount > 0 ? Number((magSum / magCount).toFixed(2)) : null },
        profundidad: { promedio_km: profCount > 0 ? Number((profSum / profCount).toFixed(1)) : null },
        distribucion_mensual: distMensual,
        distribucion_diaria: distDiaria,
        por_region: regCounts
      };

      const limit = Number(safeSearchParams.get('limit') || 50);
      const page = Number(safeSearchParams.get('page') || 1);
      const totalPags = totalFiltered > 0 ? Math.ceil(totalFiltered / limit) : 0;
      data.paginacion = {
        pagina_actual: page,
        limite: limit,
        total_registros: totalFiltered,
        total_paginas: totalPags,
        tiene_siguiente: page < totalPags,
        tiene_anterior: page > 1
      };

      if (isStatsOnly) {
        data.eventos = [];
      } else {
        const offset = (page - 1) * limit;
        data.eventos = filteredEvents.slice(offset, offset + limit);
      }
    }

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=60, s-maxage=300',
        'X-Proxy-Scope': 'preview-filtered'
      }
    });
  } catch (proxyErr) {
    return Response.json(
      {
        ok: false,
        error: 'Error al consultar el servicio de respaldo histórico en preview.',
        momento: new Date().toISOString()
      },
      { status: 502, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }
}
