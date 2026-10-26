package pa.sismodata.app;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * Gestor seguro de preferencias locales para el consentimiento y tokens FCM en sismoPA.
 * No comparte datos personales ni identificadores de hardware.
 */
public final class FcmPreferences {
    private static final String PREF_NAME = "sismopa_fcm_prefs";
    private static final String KEY_OPTED_IN = "fcm_opted_in";
    private static final String KEY_TOKEN = "fcm_token";
    private static final String KEY_TOKEN_SYNCED = "fcm_token_synced";

    private FcmPreferences() {}

    private static SharedPreferences getPrefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
    }

    public static boolean isOptedIn(Context context) {
        return getPrefs(context).getBoolean(KEY_OPTED_IN, false);
    }

    public static void setOptedIn(Context context, boolean optedIn) {
        getPrefs(context).edit().putBoolean(KEY_OPTED_IN, optedIn).apply();
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
}
