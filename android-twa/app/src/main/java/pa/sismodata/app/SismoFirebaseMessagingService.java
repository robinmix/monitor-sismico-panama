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

        String rawMag = data.get("magnitud");
        String rawLat = data.get("latitud");
        String rawLon = data.get("longitud");
        String lugar = data.get("lugar");
        if (lugar == null || lugar.isEmpty()) {
            lugar = data.get("ubicacion");
        }
        if (lugar == null || lugar.isEmpty()) {
            lugar = "Panamá";
        }
        String profKm = data.get("profundidad");
        String urlString = data.get("url");

        String magStr = (rawMag != null && !rawMag.isEmpty()) ? ("M" + rawMag) : "Sismo";
        String personalizedDistStr = null;

        // Evaluación de personalización local por distancia en el dispositivo (100% privacidad)
        if (FcmPreferences.isDistancePersonalizationActive(this)) {
            Double userLat = FcmPreferences.getUserLatitude(this);
            Double userLon = FcmPreferences.getUserLongitude(this);
            long updatedAt = FcmPreferences.getUserLocationUpdatedAt(this);
            String mode = FcmPreferences.getUserLocationMode(this);
            long now = System.currentTimeMillis();
            long ageMs = now - updatedAt;

            // Vigencia máxima de 30 días
            if (ageMs <= 30L * 24 * 3600 * 1000L && userLat != null && userLon != null) {
                String suffix = null;
                if ("ZONA".equalsIgnoreCase(mode)) {
                    suffix = "de tu zona";
                } else if ("GPS".equalsIgnoreCase(mode)) {
                    if (ageMs <= 48L * 3600 * 1000L) {
                        suffix = "de ti";
                    } else {
                        suffix = "de tu zona";
                    }
                }

                if (suffix != null && rawLat != null && rawLon != null) {
                    try {
                        double sismoLat = Double.parseDouble(rawLat);
                        double sismoLon = Double.parseDouble(rawLon);
                        double dist = FcmPreferences.haversineKm(userLat, userLon, sismoLat, sismoLon);
                        long roundedDist = Math.round(dist);
                        if (roundedDist <= 0) {
                            personalizedDistStr = "a menos de 1 km " + suffix;
                        } else {
                            personalizedDistStr = roundedDist + " km " + suffix;
                        }
                    } catch (NumberFormatException ignored) {}
                }
            }
        }

        String title;
        String body;

        if (personalizedDistStr != null) {
            // FORMATO PERSONALIZADO ESTRICTO:
            // Título: M3.5 · 42 km de ti
            title = magStr + " · " + personalizedDistStr;

            // Cuerpo: M3.5 · 42 km de ti · 60 km al sureste de Soná [· 12 km prof.]
            StringBuilder sb = new StringBuilder();
            sb.append(magStr).append(" · ").append(personalizedDistStr).append(" · ").append(lugar);
            if (profKm != null && !profKm.isEmpty()) {
                try {
                    int p = Math.round(Float.parseFloat(profKm));
                    sb.append(" · ").append(p).append(" km prof.");
                } catch (Exception ignored) {}
            }
            body = sb.toString();
        } else {
            // FORMATO GENERAL DE FALLBACK:
            title = (data.get("title") != null && !data.get("title").isEmpty())
                    ? data.get("title")
                    : (magStr + " · Nuevo sismo");

            if (data.get("body") != null && !data.get("body").isEmpty()) {
                body = data.get("body");
            } else {
                StringBuilder sb = new StringBuilder();
                sb.append(magStr).append(" · ").append(lugar);
                if (profKm != null && !profKm.isEmpty()) {
                    try {
                        int p = Math.round(Float.parseFloat(profKm));
                        sb.append(" · ").append(p).append(" km prof.");
                    } catch (Exception ignored) {}
                }
                body = sb.toString();
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
