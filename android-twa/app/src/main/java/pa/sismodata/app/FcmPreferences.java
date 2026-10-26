package pa.sismodata.app;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Gestor seguro de preferencias locales y máquina de estados FCM en sismoPA.
 * No comparte datos personales ni identificadores de hardware.
 */
public final class FcmPreferences {
    public enum State {
        DESACTIVADO,
        SOLICITANDO_PERMISO,
        SUSCRIBIENDO,
        ACTIVO,
        ERROR,
        REVOCANDO
    }

    private static final String PREF_NAME = "sismopa_fcm_prefs";
    private static final String KEY_STATE = "fcm_state";
    private static final String KEY_OPTED_IN = "fcm_opted_in";
    private static final String KEY_DECIDED = "fcm_decided_consent";
    private static final String KEY_TOPIC_SUBSCRIBED = "fcm_topic_subscribed";
    private static final String KEY_TOKEN = "fcm_token";
    private static final String KEY_TOKEN_SYNCED = "fcm_token_synced";
    private static final String KEY_LAST_ERROR = "fcm_last_error";
    private static final String PREF_PREFIX_NOTIFIED = "notif_seen_";

    private FcmPreferences() {}

    private static SharedPreferences getPrefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
    }

    public static State getState(Context context) {
        SharedPreferences prefs = getPrefs(context);
        String name = prefs.getString(KEY_STATE, null);
        if (name == null) {
            // Migración defensiva desde Alpha 1.0.4:
            // Si existía fcm_opted_in previo pero no fcm_state, verificar integridad completa
            boolean legacyOptedIn = prefs.getBoolean(KEY_OPTED_IN, false);
            String token = prefs.getString(KEY_TOKEN, null);
            boolean topicSub = prefs.getBoolean(KEY_TOPIC_SUBSCRIBED, false);
            if (legacyOptedIn && token != null && !token.isEmpty() && topicSub) {
                return State.ACTIVO;
            }
            // Si falta cualquier elemento o no fue confirmado en Firebase, forzar DESACTIVADO
            return State.DESACTIVADO;
        }
        try {
            return State.valueOf(name);
        } catch (IllegalArgumentException e) {
            return State.DESACTIVADO;
        }
    }

    public static void setState(Context context, State state) {
        if (state == null) state = State.DESACTIVADO;
        boolean isActive = (state == State.ACTIVO);
        getPrefs(context).edit()
                .putString(KEY_STATE, state.name())
                .putBoolean(KEY_OPTED_IN, isActive)
                .apply();
    }

    /**
     * El consentimiento se considera activo ÚNICAMENTE si la máquina de estados
     * se encuentra en ACTIVO, la suscripción al topic oficial fue confirmada
     * y existe un token de registro FCM válido.
     */
    public static boolean isOptedIn(Context context) {
        boolean isStateActivo = (getState(context) == State.ACTIVO);
        boolean isTopic = isTopicSubscribed(context);
        String token = getToken(context);
        return isStateActivo && isTopic && (token != null && !token.isEmpty());
    }

    public static void setOptedIn(Context context, boolean optedIn) {
        setState(context, optedIn ? State.ACTIVO : State.DESACTIVADO);
    }

    public static boolean hasDecidedConsent(Context context) {
        return getPrefs(context).getBoolean(KEY_DECIDED, false);
    }

    public static void setDecidedConsent(Context context, boolean decided) {
        getPrefs(context).edit().putBoolean(KEY_DECIDED, decided).apply();
    }

    public static boolean isTopicSubscribed(Context context) {
        return getPrefs(context).getBoolean(KEY_TOPIC_SUBSCRIBED, false);
    }

    public static void setTopicSubscribed(Context context, boolean subscribed) {
        getPrefs(context).edit().putBoolean(KEY_TOPIC_SUBSCRIBED, subscribed).apply();
    }

    public static String getLastError(Context context) {
        return getPrefs(context).getString(KEY_LAST_ERROR, "");
    }

    public static void setLastError(Context context, String error) {
        getPrefs(context).edit().putString(KEY_LAST_ERROR, error != null ? error : "").apply();
    }

    public static String getToken(Context context) {
        return getPrefs(context).getString(KEY_TOKEN, null);
    }

    public static void setToken(Context context, String token) {
        getPrefs(context).edit().putString(KEY_TOKEN, token).apply();
    }

    public static boolean isTokenSynced(Context context) {
        return getPrefs(context).getBoolean(KEY_TOKEN_SYNCED, false);
    }

    public static void setTokenSynced(Context context, boolean synced) {
        getPrefs(context).edit().putBoolean(KEY_TOKEN_SYNCED, synced).apply();
    }

    /**
     * Comprueba si un sismo ya fue notificado localmente en este dispositivo (deduplicación defensiva).
     */
    public static boolean isAlreadyNotified(Context context, String sourceUid) {
        if (sourceUid == null || sourceUid.isEmpty()) return false;
        long seenAt = getPrefs(context).getLong(PREF_PREFIX_NOTIFIED + sourceUid, 0L);
        if (seenAt == 0L) return false;
        // Considerar duplicado si se recibió en las últimas 3 horas
        return (System.currentTimeMillis() - seenAt) < (3 * 3600 * 1000L);
    }

    /**
     * Registra que un sismo ha sido notificado al usuario en este dispositivo.
     */
    public static void markAsNotified(Context context, String sourceUid) {
        if (sourceUid == null || sourceUid.isEmpty()) return;
        getPrefs(context).edit().putLong(PREF_PREFIX_NOTIFIED + sourceUid, System.currentTimeMillis()).apply();
    }
}
