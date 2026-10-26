-- ==============================================================================
-- sismoPA — Migración Aditiva: Deduplicación Atómica Distribuida y Fencing Tokens para FCM
-- Archivo: 20261026_fcm_atomic_lease_and_fencing.sql
--
-- NOTA OPERATIVA: NO EJECUTAR DIRECTAMENTE EN PRODUCCIÓN.
-- Esta migración debe aplicarse mediante el pipeline de migraciones de Supabase
-- cuando se decida desplegar y activar el envío automático a producción.
--
-- PRINCIPIOS DE DISEÑO:
-- 1. Fencing Tokens: Cada Worker que adquiere un lease genera un owner_token (UUID) único.
--    Ningún Worker lento o que haya perdido su lease puede alterar el estado de un envío posterior.
-- 2. Concurrencia Transaccional: acquire_fcm_lease resuelve condiciones de carrera atómicamente
--    en PostgreSQL con bloqueo pesimista (FOR UPDATE) y control estricto de filas modificadas.
-- 3. Entrega Ambigua: Si la conexión cae antes de recibir confirmación de Google FCM, el estado
--    se marca como 'AMBIGUO' para inhibir reenvíos duplicados a nivel nacional.
-- 4. Privacidad y Topics: En la arquitectura basada en topics (/topics/sismos_panama), los dispositivos
--    se suscriben directamente con Firebase SDK. El almacenamiento de tokens en fcm_device_tokens
--    es innecesario y se desaconseja para el público general en virtud del principio de minimización de datos.
-- ==============================================================================

-- 1. Extensión de columnas en fcm_notificaciones_enviadas para Fencing Tokens y Auditoría
ALTER TABLE public.fcm_notificaciones_enviadas
  ADD COLUMN IF NOT EXISTS owner_token UUID,
  ADD COLUMN IF NOT EXISTS message_id TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
  ADD COLUMN IF NOT EXISTS error_details TEXT;

-- 2. Validación de estados admisibles (incluyendo 'AMBIGUO')
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

-- 3. Índices especializados para validación atómica rápida
CREATE INDEX IF NOT EXISTS idx_fcm_notif_lease_owner
  ON public.fcm_notificaciones_enviadas (source_uid, target, owner_token);

CREATE INDEX IF NOT EXISTS idx_fcm_notif_reintentos
  ON public.fcm_notificaciones_enviadas (estado, intentos, lease_expires_at);

-- 4. RPC: Adquisición atómica de Lease con Fencing Token
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
  -- 4.1. Intentar inserción inicial (camino feliz en sismos verdaderamente nuevos)
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
    -- Ya existe una fila para (source_uid, target), continuamos al análisis atómico con FOR UPDATE
  END;

  -- 4.2. Bloqueo pesimista de fila para serializar Workers concurrentes
  SELECT * INTO v_record
  FROM public.fcm_notificaciones_enviadas
  WHERE source_uid = p_source_uid AND target = p_target
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('acquired', false, 'reason', 'ROW_DELETED');
  END IF;

  -- 4.3. Notificación ya entregada con éxito: CERO reenvíos
  IF v_record.estado = 'CONFIRMADA' THEN
    RETURN jsonb_build_object(
      'acquired', false,
      'reason', 'ALREADY_CONFIRMED',
      'message_id', v_record.message_id
    );
  END IF;

  -- 4.4. Entrega ambigua previa: Se omite para evitar duplicados en el topic general
  IF v_record.estado = 'AMBIGUO' THEN
    RETURN jsonb_build_object(
      'acquired', false,
      'reason', 'AMBIGUOUS_DELIVERY_PREVENTED',
      'intentos', v_record.intentos
    );
  END IF;

  -- 4.5. Lease activo en otro Worker vigente
  IF v_record.estado = 'RESERVADA' AND v_record.lease_expires_at > v_now THEN
    RETURN jsonb_build_object(
      'acquired', false,
      'reason', 'ACTIVE_LEASE_HELD',
      'lease_expires_at', v_record.lease_expires_at
    );
  END IF;

  -- 4.6. Límite de reintentos alcanzado
  IF v_record.intentos >= p_max_intentos THEN
    RETURN jsonb_build_object(
      'acquired', false,
      'reason', 'MAX_RETRIES_EXCEEDED',
      'intentos', v_record.intentos
    );
  END IF;

  -- 4.7. Reclamar lease vencido o fallido atómicamente con nuevo fencing token
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
    'action', 'LEASE_RECLAIMED'
  );
END;
$$;

-- 5. RPC: Confirmación atómica de despacho vinculada al Fencing Token
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
    AND estado = 'RESERVADA'
  RETURNING * INTO v_record;

  IF FOUND THEN
    RETURN jsonb_build_object('confirmed', true, 'message_id', p_message_id);
  ELSE
    -- Fencing token inválido o lease perdido por timeout
    RETURN jsonb_build_object(
      'confirmed', false,
      'reason', 'LEASE_LOST_OR_FENCING_TOKEN_MISMATCH'
    );
  END IF;
END;
$$;

-- 6. RPC: Registro atómico de fallo o entrega ambigua
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

-- 7. Restricción de permisos: Exclusivo para backend de confianza (service_role)
REVOKE ALL ON FUNCTION public.acquire_fcm_lease(text, text, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_fcm_dispatch(text, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_fcm_dispatch(text, text, uuid, boolean, boolean, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.acquire_fcm_lease(text, text, uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_fcm_dispatch(text, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_fcm_dispatch(text, text, uuid, boolean, boolean, text) TO service_role;
