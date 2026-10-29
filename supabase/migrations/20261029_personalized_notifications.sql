-- ==============================================================================
-- sismoPA — Migración para Notificaciones Sísmicas Personalizadas por Distancia
-- Archivo: 20261029_personalized_notifications.sql
-- Propósito: Agregar columnas de ubicación aproximada (máx 3 decimales ~110m),
--            modo, zona, marcas temporales y token de autorización del cliente
--            para permitir personalización y eliminación de datos sin cuentas.
-- ==============================================================================

DO $$
BEGIN
  -- 1. Ampliación de push_subscriptions para soporte de geodistancia
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'push_subscriptions') THEN
    -- latitud truncada a 3 decimales
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'push_subscriptions' AND column_name = 'latitud') THEN
      ALTER TABLE public.push_subscriptions ADD COLUMN latitud NUMERIC(6,3);
    END IF;

    -- longitud truncada a 3 decimales
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'push_subscriptions' AND column_name = 'longitud') THEN
      ALTER TABLE public.push_subscriptions ADD COLUMN longitud NUMERIC(6,3);
    END IF;

    -- fecha de última actualización voluntaria de ubicación
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'push_subscriptions' AND column_name = 'ubicacion_actualizada_en') THEN
      ALTER TABLE public.push_subscriptions ADD COLUMN ubicacion_actualizada_en TIMESTAMPTZ;
    END IF;

    -- modo de captura: GPS o ZONA fija
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'push_subscriptions' AND column_name = 'ubicacion_modo') THEN
      ALTER TABLE public.push_subscriptions ADD COLUMN ubicacion_modo TEXT DEFAULT 'GPS';
      ALTER TABLE public.push_subscriptions ADD CONSTRAINT chk_push_subs_modo CHECK (ubicacion_modo IN ('GPS', 'ZONA'));
    END IF;

    -- nombre legible de la zona o provincia de referencia (si aplica)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'push_subscriptions' AND column_name = 'ubicacion_zona') THEN
      ALTER TABLE public.push_subscriptions ADD COLUMN ubicacion_zona TEXT;
    END IF;

    -- precisión del reporte en metros
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'push_subscriptions' AND column_name = 'ubicacion_precision_m') THEN
      ALTER TABLE public.push_subscriptions ADD COLUMN ubicacion_precision_m NUMERIC(8,1);
    END IF;

    -- bandera de activación de personalización
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'push_subscriptions' AND column_name = 'personalizacion_distancia_activa') THEN
      ALTER TABLE public.push_subscriptions ADD COLUMN personalizacion_distancia_activa BOOLEAN DEFAULT false;
    END IF;

    -- hash de autorización del dispositivo cliente
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'push_subscriptions' AND column_name = 'client_token_hash') THEN
      ALTER TABLE public.push_subscriptions ADD COLUMN client_token_hash TEXT;
    END IF;

    -- Índices para optimización de consultas
    CREATE INDEX IF NOT EXISTS idx_push_subs_client_hash ON public.push_subscriptions (client_token_hash);
    CREATE INDEX IF NOT EXISTS idx_push_subs_personalizacion ON public.push_subscriptions (personalizacion_distancia_activa) WHERE personalizacion_distancia_activa IS TRUE;
    CREATE INDEX IF NOT EXISTS idx_push_subs_zona ON public.push_subscriptions (ubicacion_zona) WHERE ubicacion_zona IS NOT NULL;
  END IF;

  -- 2. Ampliación equivalente en fcm_device_tokens si la tabla existe
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'fcm_device_tokens') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fcm_device_tokens' AND column_name = 'latitud') THEN
      ALTER TABLE public.fcm_device_tokens ADD COLUMN latitud NUMERIC(6,3);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fcm_device_tokens' AND column_name = 'longitud') THEN
      ALTER TABLE public.fcm_device_tokens ADD COLUMN longitud NUMERIC(6,3);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fcm_device_tokens' AND column_name = 'ubicacion_actualizada_en') THEN
      ALTER TABLE public.fcm_device_tokens ADD COLUMN ubicacion_actualizada_en TIMESTAMPTZ;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fcm_device_tokens' AND column_name = 'ubicacion_modo') THEN
      ALTER TABLE public.fcm_device_tokens ADD COLUMN ubicacion_modo TEXT DEFAULT 'GPS';
      ALTER TABLE public.fcm_device_tokens ADD CONSTRAINT chk_fcm_tokens_modo CHECK (ubicacion_modo IN ('GPS', 'ZONA'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fcm_device_tokens' AND column_name = 'ubicacion_zona') THEN
      ALTER TABLE public.fcm_device_tokens ADD COLUMN ubicacion_zona TEXT;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fcm_device_tokens' AND column_name = 'ubicacion_precision_m') THEN
      ALTER TABLE public.fcm_device_tokens ADD COLUMN ubicacion_precision_m NUMERIC(8,1);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fcm_device_tokens' AND column_name = 'personalizacion_distancia_activa') THEN
      ALTER TABLE public.fcm_device_tokens ADD COLUMN personalizacion_distancia_activa BOOLEAN DEFAULT false;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fcm_device_tokens' AND column_name = 'client_token_hash') THEN
      ALTER TABLE public.fcm_device_tokens ADD COLUMN client_token_hash TEXT;
    END IF;

    CREATE INDEX IF NOT EXISTS idx_fcm_tokens_client_hash ON public.fcm_device_tokens (client_token_hash);
    CREATE INDEX IF NOT EXISTS idx_fcm_tokens_personalizacion ON public.fcm_device_tokens (personalizacion_distancia_activa) WHERE personalizacion_distancia_activa IS TRUE;
  END IF;
END $$;
