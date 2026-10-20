import { runArchival } from '../lib/archivar-sismos.mjs';

// Cloudflare Workers Cron Triggers. El Worker NO tiene URL pública que ejecute el archivado.
export default {
  async scheduled(_event, env, ctx) {
    if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
      throw new Error('Configurar SUPABASE_URL y SUPABASE_SECRET_KEY como secrets.');
    }
    ctx.waitUntil(runArchival({ env }));
  },
  async fetch() {
    return new Response('Not found', { status: 404 });
  }
};
