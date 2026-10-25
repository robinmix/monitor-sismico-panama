-- ==============================================================================
-- sismoPA — Migración aditiva para Web Push y prevención de duplicados
-- Ejecutar en Supabase SQL Editor si se desea activar la base de datos centralizada.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
  last_seen TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
  failures INTEGER DEFAULT 0 NOT NULL
);

CREATE TABLE IF NOT EXISTS public.notificaciones_enviadas (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source_uid TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  enviado_en TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
  CONSTRAINT uq_notificacion_sismo_dispositivo UNIQUE (source_uid, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subs_last_seen ON public.push_subscriptions (last_seen);
CREATE INDEX IF NOT EXISTS idx_notif_enviadas_uid ON public.notificaciones_enviadas (source_uid);

-- Políticas RLS: Seguridad estricta (exclusivo para service_role / backend)
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notificaciones_enviadas ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'push_subscriptions' AND policyname = 'Service role full access on push_subscriptions'
  ) THEN
    CREATE POLICY "Service role full access on push_subscriptions"
      ON public.push_subscriptions
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'notificaciones_enviadas' AND policyname = 'Service role full access on notificaciones_enviadas'
  ) THEN
    CREATE POLICY "Service role full access on notificaciones_enviadas"
      ON public.notificaciones_enviadas
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;
