-- ==============================================================================
-- sismoPA — Migración Aditiva: Deduplicación Atómica Distribuida, Fencing Tokens y Protección Anti-Duplicados
-- Archivo: 20261026_fcm_atomic_lease_and_fencing.sql
--
-- NOTA OPERATIVA: NO EJECUTAR DIRECTAMENTE EN PRODUCCIÓN.
-- Esta migración debe aplicarse en Supabase Production únicamente cuando se inicie
-- el procedimiento de despliegue controlado de la fase FCM.
--
-- PRINCIPIOS DE DISEÑO Y SEGURIDAD:
-- 1. Fencing Tokens: Cada Worker que adquiere un lease genera un owner_token (UUID) único.
--    Ningún Worker lento o que haya perdido su lease puede alterar el estado de un envío posterior.
-- 2. Tratamiento Conservador de Reservas Expiradas: En una difusión al topic general nacional
--    (/topics/sismos_panama), si una reserva en estado 'RESERVADA' expira sin confirmación,
--    la ejecución previa pudo haber transmitido el mensaje a Google antes de vencer.
--    Para garantizar que los usuarios NUNCA reciban alertas duplicadas de un mismo sismo,
--    la expiración de un lease en curso se transiciona atómicamente a 'AMBIGUO' y NUNCA se
--    reintenta de forma automática al topic general.
-- 3. Exclusividad RPC: El despacho automático requiere obligatoriamente estas funciones RPC.
--    No existe fallback inseguro cliente; si la RPC falla, el despacho se aborta sin llamar a Firebase.
-- 4. Privacidad y Omisión de fcm_device_tokens: En la arquitectura basada en topics, los dispositivos
--    Android se suscriben directamente con Google mediante el SDK nativo. El backend envía 1 mensaje
--    al topic general y no requiere almacenar tokens de dispositivos individuales.
--    Prescindir de la tabla fcm_device_tokens maximiza la privacidad ciudadana y elimina el mantenimiento
--    de tokens obsoletos.
-- ==============================================================================

-- 1. Creación segura y autosuficiente de la tabla fcm_notificaciones_enviadas si no existe
CREATE TABLE IF NOT EXISTS public.fcm_notificaciones_enviadas (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source_uid TEXT NOT NULL,
  target TEXT NOT NULL, -- 'topic:sismos_panama' o token de prueba
  enviado_en TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
  estado TEXT DEFAULT 'RESERVADA' NOT NULL,
  lease_expires_at TIMESTAMPTZ,
  owner_token UUID,
  intentos INTEGER DEFAULT 1 NOT NULL,
  message_id TEXT,
  error_details TEXT,
  updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
  CONSTRAINT uq_fcm_notif_sismo_target UNIQUE (source_uid, target)
);

-- 2. Asegurar columnas en caso de que la tabla existiera previamente con esquema anterior
ALTER TABLE public.fcm_notificaciones_enviadas
  ADD COLUMN IF NOT EXISTS owner_token UUID,
  ADD COLUMN IF NOT EXISTS message_id TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL,
  ADD COLUMN IF NOT EXISTS error_details TEXT;

-- 3. Validación estricta de estados admisibles
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

-- 4. Índices optimizados para concurrencia y consultas atómicas
CREATE INDEX IF NOT EXISTS idx_fcm_notif_lease_owner
  ON public.fcm_notificaciones_enviadas (source_uid, target, owner_token);

CREATE INDEX IF NOT EXISTS idx_fcm_notif_reintentos
  ON public.fcm_notificaciones_enviadas (estado, intentos, lease_expires_at);

-- 5. Seguridad a nivel de fila (Row Level Security)
ALTER TABLE public.fcm_notificaciones_enviadas ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
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

-- 6. RPC: Adquisición atómica de Lease con Fencing Token y Política Anti-Duplicados
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
  -- 6.1. Intentar inserción inicial de reserva (camino feliz en sismos verdaderamente nuevos)
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
    -- Ya existe una fila para (source_uid, target), evaluamos atómicamente con FOR UPDATE
  END;

  -- 6.2. Bloqueo pesimista de fila para serializar Workers concurrentes
  SELECT * INTO v_record
  FROM public.fcm_notificaciones_enviadas
  WHERE source_uid = p_source_uid AND target = p_target
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('acquired', false, 'reason', 'ROW_DELETED');
  END IF;

  -- 6.3. Si ya fue confirmada previamente: CERO reenvíos, omitir permanentemente
  IF v_record.estado = 'CONFIRMADA' THEN
    RETURN jsonb_build_object(
      'acquired', false,
      'reason', 'ALREADY_CONFIRMED',
      'message_id', v_record.message_id
    );
  END IF;

  -- 6.4. Si el estado es AMBIGUO: envío potencialmente recibido por Google FCM; NO reintentar
  IF v_record.estado = 'AMBIGUO' THEN
    RETURN jsonb_build_object(
      'acquired', false,
      'reason', 'AMBIGUOUS_DELIVERY_PREVENTED',
      'intentos', v_record.intentos
    );
  END IF;

  -- 6.5. Si está RESERVADA y el lease sigue vigente: otra instancia activa tiene la propiedad
  IF v_record.estado = 'RESERVADA' AND v_record.lease_expires_at > v_now THEN
    RETURN jsonb_build_object(
      'acquired', false,
      'reason', 'ACTIVE_LEASE_HELD',
      'lease_expires_at', v_record.lease_expires_at
    );
  END IF;

  -- 6.6. TRATAMIENTO CONSERVADOR CRÍTICO:
  -- Si está RESERVADA pero el lease expiró: la ejecución anterior pudo haber enviado la solicitud a Firebase
  -- antes de colapsar o agotarse el tiempo. Para garantizar que los usuarios nunca reciban alertas duplicadas
  -- en el topic nacional, la expiración de una reserva en curso NUNCA permite un reenvío automático ciego.
  -- Se transiciona a AMBIGUO de forma definitiva.
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

  -- 6.7. Si está FALLIDA (rechazo explícito y confirmado por Google, ej. 500/429): verificar intentos
  IF v_record.intentos >= p_max_intentos THEN
    RETURN jsonb_build_object(
      'acquired', false,
      'reason', 'MAX_RETRIES_EXCEEDED',
      'intentos', v_record.intentos
    );
  END IF;

  -- 6.8. Reclamar fallo temporal atómicamente con nuevo fencing token
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

-- 7. RPC: Confirmación atómica de despacho vinculada al Fencing Token
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
  -- Permite confirmar si el owner_token coincide exactamente, incluso si el lease expiró
  -- recientemente pero el Worker legítimo completó exitosamente la entrega HTTP 200 en Google.
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

-- 8. RPC: Registro atómico de fallo o entrega ambigua
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

-- 9. Restricción estricta de privilegios: Exclusivo para service_role
REVOKE ALL ON FUNCTION public.acquire_fcm_lease(text, text, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_fcm_dispatch(text, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_fcm_dispatch(text, text, uuid, boolean, boolean, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.acquire_fcm_lease(text, text, uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_fcm_dispatch(text, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_fcm_dispatch(text, text, uuid, boolean, boolean, text) TO service_role;
