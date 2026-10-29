-- ==============================================================================
-- sismoPA — Reversión de Migración para Notificaciones Personalizadas por Distancia
-- Archivo: 20261029_personalized_notifications_rollback.sql
-- Propósito: Eliminar de forma segura y controlada las columnas de geodistancia
--            agregadas a push_subscriptions.
-- Idempotencia: 100% segura, ejecutable múltiples veces sin error.
-- ==============================================================================

DO $$
BEGIN
  -- 1. Reversión exclusiva en push_subscriptions
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
END $$;
