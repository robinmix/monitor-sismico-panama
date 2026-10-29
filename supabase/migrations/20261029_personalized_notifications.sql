-- ==============================================================================
-- sismoPA — Migración para Notificaciones Sísmicas Personalizadas por Distancia
-- Archivo: 20261029_personalized_notifications.sql
-- Propósito: Agregar columnas de geodistancia aproximada exclusivamente a push_subscriptions.
--            La app Android TWA/FCM calcula distancias localmente y no almacena
--            coordenadas en Supabase (arquitectura de privacidad estricta).
-- Idempotencia: 100% segura, ejecutable múltiples veces sin error.
-- ==============================================================================

DO $$
BEGIN
  -- 1. Ampliación exclusiva de push_subscriptions para soporte de geodistancia Web Push
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'push_subscriptions') THEN
    -- latitud truncada a 3 decimales (~110m)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'push_subscriptions' AND column_name = 'latitud') THEN
      ALTER TABLE public.push_subscriptions ADD COLUMN latitud NUMERIC(6,3);
    END IF;

    -- longitud truncada a 3 decimales (~110m)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'push_subscriptions' AND column_name = 'longitud') THEN
      ALTER TABLE public.push_subscriptions ADD COLUMN longitud NUMERIC(6,3);
    END IF;

    -- fecha de última actualización voluntaria de ubicación
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'push_subscriptions' AND column_name = 'ubicacion_actualizada_en') THEN
      ALTER TABLE public.push_subscriptions ADD COLUMN ubicacion_actualizada_en TIMESTAMPTZ;
    END IF;

    -- modo de captura: GPS, ZONA, PROVINCIA, MANUAL o INACTIVO
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'push_subscriptions' AND column_name = 'ubicacion_modo') THEN
      ALTER TABLE public.push_subscriptions ADD COLUMN ubicacion_modo TEXT DEFAULT 'INACTIVO';
    END IF;

    -- Asegurar restricción CHECK amplia y tolerante
    IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'chk_push_subs_modo' AND table_name = 'push_subscriptions') THEN
      ALTER TABLE public.push_subscriptions ADD CONSTRAINT chk_push_subs_modo 
        CHECK (ubicacion_modo IN ('GPS', 'ZONA', 'PROVINCIA', 'MANUAL', 'INACTIVO') OR ubicacion_modo IS NULL);
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

    -- hash criptográfico SHA-256 de autorización del dispositivo cliente
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'push_subscriptions' AND column_name = 'client_token_hash') THEN
      ALTER TABLE public.push_subscriptions ADD COLUMN client_token_hash TEXT;
    END IF;

    -- Índices para optimización de consultas en el Worker
    CREATE INDEX IF NOT EXISTS idx_push_subs_client_hash ON public.push_subscriptions (client_token_hash);
    CREATE INDEX IF NOT EXISTS idx_push_subs_personalizacion ON public.push_subscriptions (personalizacion_distancia_activa) WHERE personalizacion_distancia_activa IS TRUE;
    CREATE INDEX IF NOT EXISTS idx_push_subs_zona ON public.push_subscriptions (ubicacion_zona) WHERE ubicacion_zona IS NOT NULL;
  END IF;
END $$;
