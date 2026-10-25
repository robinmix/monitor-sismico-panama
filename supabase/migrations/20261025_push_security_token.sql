-- ==============================================================================
-- sismoPA — Migración aditiva: Seguridad y autorización Web Push
-- Añade soporte para tokens revocables de prueba (almacenados como hash SHA-256)
-- y control estricto de frecuencia de envío (rate limiting).
-- ==============================================================================

ALTER TABLE public.push_subscriptions 
  ADD COLUMN IF NOT EXISTS test_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS last_test_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS vapid_key_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_push_subs_test_token ON public.push_subscriptions (test_token_hash);
