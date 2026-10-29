-- ==============================================================================
-- sismoPA — Rollback de Notificaciones Sísmicas Personalizadas por Distancia
-- Archivo: 20261029_personalized_notifications_rollback.sql
-- Propósito: Reversión limpia y segura de las columnas añadidas en
--            push_subscriptions y fcm_device_tokens.
-- ==============================================================================

DO $$
BEGIN
  -- 1. Reversión en push_subscriptions
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'push_subscriptions') THEN
    DROP INDEX IF EXISTS public.idx_push_subs_zona;
    DROP INDEX IF EXISTS public.idx_push_subs_personalizacion;
    DROP INDEX IF EXISTS public.idx_push_subs_client_hash;

    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'chk_push_subs_modo' AND table_name = 'push_subscriptions') THEN
      ALTER TABLE public.push_subscriptions DROP CONSTRAINT chk_push_subs_modo;
    END IF;

    ALTER TABLE public.push_subscriptions DROP COLUMN IF EXISTS client_token_hash;
    ALTER TABLE public.push_subscriptions DROP COLUMN IF EXISTS personalizacion_distancia_activa;
    ALTER TABLE public.push_subscriptions DROP COLUMN IF EXISTS ubicacion_precision_m;
    ALTER TABLE public.push_subscriptions DROP COLUMN IF EXISTS ubicacion_zona;
    ALTER TABLE public.push_subscriptions DROP COLUMN IF EXISTS ubicacion_modo;
    ALTER TABLE public.push_subscriptions DROP COLUMN IF EXISTS ubicacion_actualizada_en;
    ALTER TABLE public.push_subscriptions DROP COLUMN IF EXISTS longitud;
    ALTER TABLE public.push_subscriptions DROP COLUMN IF EXISTS latitud;
  END IF;

  -- 2. Reversión en fcm_device_tokens
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'fcm_device_tokens') THEN
    DROP INDEX IF EXISTS public.idx_fcm_tokens_personalizacion;
    DROP INDEX IF EXISTS public.idx_fcm_tokens_client_hash;

    IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'chk_fcm_tokens_modo' AND table_name = 'fcm_device_tokens') THEN
      ALTER TABLE public.fcm_device_tokens DROP CONSTRAINT chk_fcm_tokens_modo;
    END IF;

    ALTER TABLE public.fcm_device_tokens DROP COLUMN IF EXISTS client_token_hash;
    ALTER TABLE public.fcm_device_tokens DROP COLUMN IF EXISTS personalizacion_distancia_activa;
    ALTER TABLE public.fcm_device_tokens DROP COLUMN IF EXISTS ubicacion_precision_m;
    ALTER TABLE public.fcm_device_tokens DROP COLUMN IF EXISTS ubicacion_zona;
    ALTER TABLE public.fcm_device_tokens DROP COLUMN IF EXISTS ubicacion_modo;
    ALTER TABLE public.fcm_device_tokens DROP COLUMN IF EXISTS ubicacion_actualizada_en;
    ALTER TABLE public.fcm_device_tokens DROP COLUMN IF EXISTS longitud;
    ALTER TABLE public.fcm_device_tokens DROP COLUMN IF EXISTS latitud;
  END IF;
END $$;
