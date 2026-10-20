// Adaptador para respuestas de las funciones originales (Netlify) al runtime Pages.
export function eventoNetlify(request) {
  const url = new URL(request.url);
  return {
    httpMethod: request.method,
    queryStringParameters: Object.fromEntries(url.searchParams.entries()),
    headers: Object.fromEntries(request.headers.entries())
  };
}

export function respuestaPages(resultado) {
  return new Response(resultado.body ?? '', {
    status: resultado.statusCode || 200,
    headers: resultado.headers || { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
