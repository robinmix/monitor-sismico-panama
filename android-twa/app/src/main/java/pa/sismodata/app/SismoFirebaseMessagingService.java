package pa.sismodata.app;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * Servicio FCM nativo oficial para sismoPA.
 * Procesa alertas sísmicas y genera notificaciones locales 100% nativas
 * atribuidas exclusivamente a sismoPA con icono monocromático propio.
 */
public class SismoFirebaseMessagingService extends FirebaseMessagingService {
    private static final String TAG = "SismoFcmService";
    private static final String API_ENDPOINT = "https://sismopa.pages.dev/api/fcm-subscribe";

    @Override
    public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        Log.i(TAG, "Nuevo token FCM recibido en el dispositivo");
        FcmPreferences.setToken(this, token);

        // Si el usuario ya dio su consentimiento voluntario previo, sincronizar el nuevo token
        if (FcmPreferences.isOptedIn(this)) {
            syncTokenWithServer(this, token, true);
        }
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);
        Log.i(TAG, "Mensaje FCM recibido de: " + remoteMessage.getFrom());

        // Asegurar que el canal de notificaciones esté activo (Android 8.0+)
        SismoNotificationHelper.createNotificationChannel(this);

        Map<String, String> data = remoteMessage.getData();
        String title = data.get("title");
        String body = data.get("body");
        String sourceUid = data.get("source_uid");
        String urlString = data.get("url");

        if (title == null || title.isEmpty()) {
            if (remoteMessage.getNotification() != null && remoteMessage.getNotification().getTitle() != null) {
                title = remoteMessage.getNotification().getTitle();
            } else {
                title = "sismoPA — Alerta Sísmica";
            }
        }

        if (body == null || body.isEmpty()) {
            if (remoteMessage.getNotification() != null && remoteMessage.getNotification().getBody() != null) {
                body = remoteMessage.getNotification().getBody();
            } else {
                body = "Nuevo sismo registrado por el IGC-UP en Panamá.";
            }
        }

        Intent intent = new Intent(this, LauncherActivity.class);
        intent.setAction(Intent.ACTION_VIEW);

        if (urlString != null && !urlString.isEmpty()) {
            intent.setData(Uri.parse(urlString));
        } else if (sourceUid != null && !sourceUid.isEmpty()) {
            intent.setData(Uri.parse("https://sismopa.pages.dev/?sismo=" + Uri.encode(sourceUid)));
        } else {
            intent.setData(Uri.parse("https://sismopa.pages.dev/"));
        }

        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);

        int requestCode = (sourceUid != null) ? Math.abs(sourceUid.hashCode()) : (int) System.currentTimeMillis();
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }

        PendingIntent pendingIntent = PendingIntent.getActivity(this, requestCode, intent, flags);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, SismoNotificationHelper.CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification_icon)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setColor(0xFFD32F2F)
                .setAutoCancel(true)
                .setContentIntent(pendingIntent);

        int notifId = (sourceUid != null) ? Math.abs(sourceUid.hashCode()) : 1001;

        try {
            NotificationManagerCompat.from(this).notify(notifId, builder.build());
            Log.i(TAG, "Notificación nativa sismoPA enviada al gestor de Android. ID: " + notifId);
        } catch (SecurityException se) {
            Log.w(TAG, "Permiso POST_NOTIFICATIONS denegado en Android 13+: " + se.getMessage());
        } catch (Exception e) {
            Log.e(TAG, "Error al mostrar notificación: " + e.getMessage(), e);
        }
    }

    /**
     * Sincroniza el token FCM con el servidor de forma asíncrona mediante HTTPS.
     */
    public static void syncTokenWithServer(Context context, String token, boolean subscribe) {
        if (token == null || token.isEmpty()) return;

        new Thread(() -> {
            HttpURLConnection conn = null;
            try {
                URL url = new URL(API_ENDPOINT);
                conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                conn.setRequestProperty("Accept", "application/json");
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(10000);
                conn.setDoOutput(true);

                String action = subscribe ? "subscribe" : "unsubscribe";
                String payload = "{\"action\":\"" + action + "\",\"token\":\"" + token + "\",\"platform\":\"android\",\"app_version\":\"1.0.4\"}";

                byte[] out = payload.getBytes(StandardCharsets.UTF_8);
                conn.setFixedLengthStreamingMode(out.length);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(out);
                }

                int code = conn.getResponseCode();
                if (code >= 200 && code < 300) {
                    FcmPreferences.setTokenSynced(context, subscribe);
                    Log.i(TAG, "Token FCM sincronizado exitosamente con el servidor. Acción: " + action);
                } else {
                    Log.w(TAG, "Servidor retornó código HTTP " + code + " al registrar token FCM");
                }
            } catch (Exception e) {
                Log.w(TAG, "Error de red al sincronizar token FCM: " + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        }).start();
    }
}
