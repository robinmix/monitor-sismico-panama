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
      'desde', 'from', 'hasta', 'to', 'sort', 'search', 'q', 'buscar', 'include_stats'
    ];
    const safeSearchParams = new URLSearchParams();
    for (const [key, value] of reqUrl.searchParams.entries()) {
      if (allowedParams.includes(key.toLowerCase())) {
        safeSearchParams.set(key, value);
      }
    }

    const targetUrl = `${PROD_ENDPOINT}?${safeSearchParams.toString()}`;
    const prodRes = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'sismoPA-Cloudflare-Preview-Proxy/1.0'
      }
    });

    const bodyText = await prodRes.text();
    return new Response(bodyText, {
      status: prodRes.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=60, s-maxage=300',
        'X-Proxy-Scope': 'preview-only'
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
