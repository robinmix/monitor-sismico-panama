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

import java.util.Map;

/**
 * Servicio FCM nativo oficial para sismoPA.
 * Procesa alertas sísmicas y genera notificaciones locales 100% nativas
 * atribuidas exclusivamente a sismoPA con icono monocromático propio.
 */
public class SismoFirebaseMessagingService extends FirebaseMessagingService {
    private static final String TAG = "SismoFcmService";

    @Override
    public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        Log.i(TAG, "Nuevo token FCM recibido en el dispositivo");
        FcmPreferences.setToken(this, token);

        // Si el usuario ya dio su consentimiento voluntario y está activo, reasegurar suscripción al topic
        if (FcmPreferences.isOptedIn(this)) {
            com.google.firebase.messaging.FirebaseMessaging.getInstance()
                    .subscribeToTopic(LauncherActivity.FCM_TOPIC)
                    .addOnCompleteListener(task -> {
                        if (task.isSuccessful()) {
                            FcmPreferences.setTopicSubscribed(this, true);
                            Log.i(TAG, "Suscripción al topic sismos_panama reasegurada tras renovación de token");
                        } else {
                            Log.w(TAG, "Aviso: fallo al reasegurar topic sismos_panama tras renovación de token");
                        }
                    });
        }
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        super.onMessageReceived(remoteMessage);
        Log.i(TAG, "Mensaje FCM recibido de: " + remoteMessage.getFrom());

        // Comprobación estricta de consentimiento: si el usuario no está en estado ACTIVO, suprimir mensaje
        if (!FcmPreferences.isOptedIn(this)) {
            Log.i(TAG, "Mensaje FCM omitido: alertas no activas en la máquina de estados local.");
            return;
        }

        Map<String, String> data = remoteMessage.getData();
        String sourceUid = data.get("source_uid");

        // Deduplicación preventiva local en el dispositivo (evita duplicados si llega por múltiples rutas)
        if (sourceUid != null && FcmPreferences.isAlreadyNotified(this, sourceUid)) {
            Log.i(TAG, "Notificación omitida por deduplicación local para el evento: " + sourceUid);
            return;
        }

        // Asegurar que el canal de notificaciones esté activo (Android 8.0+)
        SismoNotificationHelper.createNotificationChannel(this);

        String title = data.get("title");
        String body = data.get("body");
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
            FcmPreferences.markAsNotified(this, sourceUid);
            Log.i(TAG, "Notificación nativa sismoPA enviada al gestor de Android. ID: " + notifId);
        } catch (SecurityException se) {
            Log.w(TAG, "Permiso POST_NOTIFICATIONS denegado en Android 13+: " + se.getMessage());
        } catch (Exception e) {
            Log.e(TAG, "Error al mostrar notificación: " + e.getMessage(), e);
        }
    }

    /**
     * @deprecated En la arquitectura basada en Firebase Topics (/topics/sismos_panama),
     * los dispositivos no requieren sincronizar tokens individuales con Supabase.
     * Este método se conserva como no-op por compatibilidad retroactiva.
     */
    @Deprecated
    public static void syncTokenWithServer(Context context, String token, boolean subscribe) {
        // No-op seguro: el despacho se realiza a nivel de topic general sin almacenar tokens individuales.
    }
}
