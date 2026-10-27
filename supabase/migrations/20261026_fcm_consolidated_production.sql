-- ==============================================================================
-- sismoPA — Migración Consolidada para Producción Supabase:
-- Deduplicación Atómica Distribuida, Fencing Tokens y Alertas Sísmicas FCM
-- Archivo: supabase/migrations/20261026_fcm_consolidated_production.sql
--
-- INSTRUCCIONES:
-- Ejecutar este script completo de una sola vez en el SQL Editor de Supabase
-- (https://supabase.com/dashboard/project/_/sql).
-- Es 100% idempotente y seguro: no altera el historial sísmico de Supabase ni
-- afecta las suscripciones Web Push existentes en producción.
-- ==============================================================================

-- 1. Tabla de registro de dispositivos (opcional / auditoría)
CREATE TABLE IF NOT EXISTS public.fcm_device_tokens (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  device_id_hash TEXT,
  platform TEXT DEFAULT 'android' NOT NULL,
  app_version TEXT DEFAULT '1.0.8' NOT NULL,
  created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
  last_seen TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
  failures INTEGER DEFAULT 0 NOT NULL,
  last_failure_at TIMESTAMPTZ,
  retry_after TIMESTAMPTZ,
  active BOOLEAN DEFAULT true NOT NULL
);

-- 2. Tabla de deduplicación y estado de notificaciones FCM
CREATE TABLE IF NOT EXISTS public.fcm_notificaciones_enviadas (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source_uid TEXT NOT NULL,
  target TEXT NOT NULL, -- 'topic:sismos_panama' o token individual
  enviado_en TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
  estado TEXT DEFAULT 'RESERVADA' NOT NULL, -- 'RESERVADA', 'CONFIRMADA', 'FALLIDA', 'AMBIGUO'
  lease_expires_at TIMESTAMPTZ,
  owner_token UUID,
  intentos INTEGER DEFAULT 1 NOT NULL,
  message_id TEXT,
  error_details TEXT,
  updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
  CONSTRAINT uq_fcm_notif_sismo_target UNIQUE (source_uid, target)
);

-- 3. Asegurar columnas para compatibilidad hacia atrás
ALTER TABLE public.fcm_notificaciones_enviadas
  ADD COLUMN IF NOT EXISTS owner_token UUID,
  ADD COLUMN IF NOT EXISTS message_id TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
  ADD COLUMN IF NOT EXISTS error_details TEXT;

-- 4. Restricción de estados válidos
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_fcm_notif_estado_valido'
  ) THEN
    ALTER TABLE public.fcm_notificaciones_enviadas
      ADD CONSTRAINT chk_fcm_notif_estado_valido
      CHECK (estado IN ('RESERVADA', 'CONFIRMADA', 'FALLIDA', 'AMBIGUO'));
  END IF;
END $$;

-- 5. Índices de rendimiento y concurrencia
CREATE INDEX IF NOT EXISTS idx_fcm_tokens_active_last_seen
  ON public.fcm_device_tokens (active, last_seen);

CREATE INDEX IF NOT EXISTS idx_fcm_tokens_retry_after
  ON public.fcm_device_tokens (retry_after);

CREATE INDEX IF NOT EXISTS idx_fcm_notif_source_uid
  ON public.fcm_notificaciones_enviadas (source_uid);

CREATE INDEX IF NOT EXISTS idx_fcm_notif_lease_owner
  ON public.fcm_notificaciones_enviadas (source_uid, target, owner_token);

CREATE INDEX IF NOT EXISTS idx_fcm_notif_reintentos
  ON public.fcm_notificaciones_enviadas (estado, intentos, lease_expires_at);

-- 6. Seguridad RLS y Políticas de acceso
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

-- 7. RPC: acquire_fcm_lease (Adquisición atómica con Fencing Token y Bloqueo Pesimista)
CREATE OR REPLACE FUNCTION public.acquire_fcm_lease(
  p_source_uid text,
  p_target text,
  p_owner_token uuid,
  p_lease_seconds integer DEFAULT 60,
  p_max_intentos integer DEFAULT 3
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := timezone('utc'::text, now());
  v_lease_expiry timestamptz := v_now + (p_lease_seconds || ' seconds')::interval;
  v_record public.fcm_notificaciones_enviadas%ROWTYPE;
BEGIN
  -- Intento inicial de inserción (camino feliz en sismos nuevos)
  BEGIN
    INSERT INTO public.fcm_notificaciones_enviadas (
      source_uid,
      target,
      enviado_en,
      estado,
      lease_expires_at,
      owner_token,
      intentos,
      updated_at
    ) VALUES (
      p_source_uid,
      p_target,
      v_now,
      'RESERVADA',
      v_lease_expiry,
      p_owner_token,
      1,
      v_now
    )
    RETURNING * INTO v_record;

    RETURN jsonb_build_object(
      'acquired', true,
      'status', 'RESERVADA',
      'owner_token', p_owner_token,
      'intentos', 1,
      'action', 'INSERTED'
    );
  EXCEPTION WHEN unique_violation THEN
    -- Ya existe una fila para (source_uid, target); serializamos con FOR UPDATE
  END;

  -- Bloqueo pesimista de fila
  SELECT * INTO v_record
  FROM public.fcm_notificaciones_enviadas
  WHERE source_uid = p_source_uid AND target = p_target
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('acquired', false, 'reason', 'ROW_DELETED');
  END IF;

  -- Si ya fue confirmada previamente: CERO reenvíos, omitir permanentemente
  IF v_record.estado = 'CONFIRMADA' THEN
    RETURN jsonb_build_object(
      'acquired', false,
      'reason', 'ALREADY_CONFIRMED',
      'message_id', v_record.message_id
    );
  END IF;

  -- Si el estado es AMBIGUO: envío potencialmente recibido por Google FCM; NO reintentar
  IF v_record.estado = 'AMBIGUO' THEN
    RETURN jsonb_build_object(
      'acquired', false,
      'reason', 'AMBIGUOUS_DELIVERY_PREVENTED',
      'intentos', v_record.intentos
    );
  END IF;

  -- Si está RESERVADA y el lease sigue vigente: otra instancia activa tiene la propiedad
  IF v_record.estado = 'RESERVADA' AND v_record.lease_expires_at > v_now THEN
    RETURN jsonb_build_object(
      'acquired', false,
      'reason', 'ACTIVE_LEASE_HELD',
      'lease_expires_at', v_record.lease_expires_at
    );
  END IF;

  -- Si está RESERVADA pero el lease expiró: transición conservadora a AMBIGUO para evitar duplicados en topic
  IF v_record.estado = 'RESERVADA' AND v_record.lease_expires_at <= v_now THEN
    UPDATE public.fcm_notificaciones_enviadas
    SET estado = 'AMBIGUO',
        lease_expires_at = NULL,
        error_details = 'Reserva expirada en tránsito; reenvío prevenido conservadoramente para evitar duplicados en topic nacional',
        updated_at = v_now,
        intentos = 99
    WHERE source_uid = p_source_uid
      AND target = p_target;

    RETURN jsonb_build_object(
      'acquired', false,
      'reason', 'EXPIRED_RESERVATION_TRANSITIONED_TO_AMBIGUOUS_NO_RETRY',
      'action', 'ABORT_DUPLICATE_PREVENTION'
    );
  END IF;

  -- Si está FALLIDA: verificar intentos máximos
  IF v_record.intentos >= p_max_intentos THEN
    RETURN jsonb_build_object(
      'acquired', false,
      'reason', 'MAX_RETRIES_EXCEEDED',
      'intentos', v_record.intentos
    );
  END IF;

  -- Reclamar fallo temporal atómicamente con nuevo fencing token
  UPDATE public.fcm_notificaciones_enviadas
  SET estado = 'RESERVADA',
      lease_expires_at = v_lease_expiry,
      owner_token = p_owner_token,
      intentos = v_record.intentos + 1,
      updated_at = v_now
  WHERE source_uid = p_source_uid
    AND target = p_target
  RETURNING * INTO v_record;

  RETURN jsonb_build_object(
    'acquired', true,
    'status', 'RESERVADA',
    'owner_token', p_owner_token,
    'intentos', v_record.intentos,
    'action', 'LEASE_RECLAIMED_FROM_FAILED'
  );
END;
$$;

-- 8. RPC: confirm_fcm_dispatch (Confirmación atómica vinculada al Fencing Token)
CREATE OR REPLACE FUNCTION public.confirm_fcm_dispatch(
  p_source_uid text,
  p_target text,
  p_owner_token uuid,
  p_message_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := timezone('utc'::text, now());
  v_record public.fcm_notificaciones_enviadas%ROWTYPE;
BEGIN
  UPDATE public.fcm_notificaciones_enviadas
  SET estado = 'CONFIRMADA',
      enviado_en = v_now,
      lease_expires_at = NULL,
      message_id = p_message_id,
      updated_at = v_now
  WHERE source_uid = p_source_uid
    AND target = p_target
    AND owner_token = p_owner_token
    AND estado IN ('RESERVADA', 'AMBIGUO')
  RETURNING * INTO v_record;

  IF FOUND THEN
    RETURN jsonb_build_object('confirmed', true, 'message_id', p_message_id);
  ELSE
    RETURN jsonb_build_object(
      'confirmed', false,
      'reason', 'LEASE_LOST_OR_FENCING_TOKEN_MISMATCH'
    );
  END IF;
END;
$$;

-- 9. RPC: fail_fcm_dispatch (Registro atómico de fallo o ambigüedad)
CREATE OR REPLACE FUNCTION public.fail_fcm_dispatch(
  p_source_uid text,
  p_target text,
  p_owner_token uuid,
  p_is_ambiguous boolean DEFAULT false,
  p_is_retryable boolean DEFAULT false,
  p_error_details text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := timezone('utc'::text, now());
  v_new_estado text;
  v_record public.fcm_notificaciones_enviadas%ROWTYPE;
BEGIN
  IF p_is_ambiguous THEN
    v_new_estado := 'AMBIGUO';
  ELSE
    v_new_estado := 'FALLIDA';
  END IF;

  UPDATE public.fcm_notificaciones_enviadas
  SET estado = v_new_estado,
      lease_expires_at = NULL,
      updated_at = v_now,
      error_details = p_error_details,
      intentos = CASE WHEN (NOT p_is_retryable OR p_is_ambiguous) THEN 99 ELSE intentos END
  WHERE source_uid = p_source_uid
    AND target = p_target
    AND owner_token = p_owner_token
    AND estado = 'RESERVADA'
  RETURNING * INTO v_record;

  IF FOUND THEN
    RETURN jsonb_build_object('failed', true, 'estado', v_new_estado);
  ELSE
    RETURN jsonb_build_object('failed', false, 'reason', 'LEASE_LOST_OR_FENCING_TOKEN_MISMATCH');
  END IF;
END;
$$;

-- 10. Permisos y Privilegios: Exclusivo para service_role (Cero acceso público/anónimo)
REVOKE ALL ON FUNCTION public.acquire_fcm_lease(text, text, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_fcm_dispatch(text, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_fcm_dispatch(text, text, uuid, boolean, boolean, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.acquire_fcm_lease(text, text, uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_fcm_dispatch(text, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_fcm_dispatch(text, text, uuid, boolean, boolean, text) TO service_role;

-- 11. Verificación final de integridad de objetos creados
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc
  WHERE proname IN ('acquire_fcm_lease', 'confirm_fcm_dispatch', 'fail_fcm_dispatch');

  IF v_count = 3 THEN
    RAISE NOTICE 'sismoPA: Las 3 funciones RPC atómicas para FCM se crearon exitosamente.';
  ELSE
    RAISE EXCEPTION 'sismoPA: Error, solo se encontraron % de 3 funciones RPC.', v_count;
  END IF;
END $$;
