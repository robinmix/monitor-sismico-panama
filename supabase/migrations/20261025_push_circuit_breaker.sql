-- ==============================================================================
-- sismoPA — Migración aditiva: Circuit Breaker y Cooldown para Web Push
-- Añade soporte para Retry-After y recuperación automática tras fallos temporales.
-- ==============================================================================

ALTER TABLE public.push_subscriptions
  ADD COLUMN IF NOT EXISTS retry_after TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_failure_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_push_subs_retry_after ON public.push_subscriptions (retry_after);
