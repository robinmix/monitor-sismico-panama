-- ==============================================================================
-- sismoPA — Migración aditiva: Gestión de dispositivos Android FCM nativos
-- Preserva íntegramente las tablas Web Push existentes (push_subscriptions, etc.)
-- y añade soporte para tokens FCM de la APK oficial de Google Play.
-- ==============================================================================

-- 1. Registro de tokens de dispositivos FCM
CREATE TABLE IF NOT EXISTS public.fcm_device_tokens (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  device_id_hash TEXT, -- Hash anónimo SHA-256 opcional para deduplicación sin datos personales
  platform TEXT DEFAULT 'android' NOT NULL, -- 'android'
  app_version TEXT DEFAULT '1.0.4' NOT NULL,
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
  last_seen TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
  failures INTEGER DEFAULT 0 NOT NULL,
  last_failure_at TIMESTAMPTZ,
  retry_after TIMESTAMPTZ,
  active BOOLEAN DEFAULT true NOT NULL
);

-- 2. Registro de notificaciones FCM emitidas por sismo para evitar duplicados
CREATE TABLE IF NOT EXISTS public.fcm_notificaciones_enviadas (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source_uid TEXT NOT NULL,
  target TEXT NOT NULL, -- 'topic:sismos_panama' o token individual
  enviado_en TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
  estado TEXT DEFAULT 'CONFIRMADA' NOT NULL, -- 'RESERVADA', 'CONFIRMADA', 'FALLIDA'
  lease_expires_at TIMESTAMPTZ,
  intentos INTEGER DEFAULT 1 NOT NULL,
  CONSTRAINT uq_fcm_notif_sismo_target UNIQUE (source_uid, target)
);

-- 3. Índices optimizados para consulta rápida y mantenimiento periódico
CREATE INDEX IF NOT EXISTS idx_fcm_tokens_active_last_seen ON public.fcm_device_tokens (active, last_seen);
CREATE INDEX IF NOT EXISTS idx_fcm_tokens_retry_after ON public.fcm_device_tokens (retry_after);
CREATE INDEX IF NOT EXISTS idx_fcm_notif_source_uid ON public.fcm_notificaciones_enviadas (source_uid);
CREATE INDEX IF NOT EXISTS idx_fcm_notif_estado_lease ON public.fcm_notificaciones_enviadas (source_uid, estado, lease_expires_at);

-- 4. Seguridad RLS: Exclusivo para backend de confianza (service_role)
ALTER TABLE public.fcm_device_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fcm_notificaciones_enviadas ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'fcm_device_tokens' AND policyname = 'Service role full access on fcm_device_tokens'
  ) THEN
    CREATE POLICY "Service role full access on fcm_device_tokens"
      ON public.fcm_device_tokens
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'fcm_notificaciones_enviadas' AND policyname = 'Service role full access on fcm_notificaciones_enviadas'
  ) THEN
    CREATE POLICY "Service role full access on fcm_notificaciones_enviadas"
      ON public.fcm_notificaciones_enviadas
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;
