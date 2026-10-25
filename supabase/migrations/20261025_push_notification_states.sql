-- ==============================================================================
-- sismoPA — Migración aditiva: Máquina de estados y lease de reservas para Web Push
-- Añade soporte para estados de entrega y recuperación de reservas abandonadas.
-- ==============================================================================

ALTER TABLE public.notificaciones_enviadas
  ADD COLUMN IF NOT EXISTS estado TEXT DEFAULT 'CONFIRMADA' NOT NULL,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS intentos INTEGER DEFAULT 1 NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notif_enviadas_estado_lease ON public.notificaciones_enviadas (source_uid, estado, lease_expires_at);
