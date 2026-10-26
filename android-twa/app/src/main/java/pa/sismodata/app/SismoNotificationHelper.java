package pa.sismodata.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

public final class SismoNotificationHelper {
    public static final String CHANNEL_ID = "sismo_alertas_channel";
    public static final String CHANNEL_NAME = "Alertas de sismos en Panamá";
    public static final String CHANNEL_DESCRIPTION = "Avisos inmediatos oficiales de actividad sísmica reportada por el IGC-UP emitidos por sismoPA.";
    private static final String TAG = "SismoNotifHelper";
    public static final int TEST_NOTIFICATION_ID = 9999;

    private SismoNotificationHelper() {}

    public static void createNotificationChannel(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            if (manager == null) {
                Log.w(TAG, "NotificationManager no disponible");
                return;
            }

            // Si el canal ya existe, no sobrescribir preferencias del usuario
            if (manager.getNotificationChannel(CHANNEL_ID) != null) {
                return;
            }

            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription(CHANNEL_DESCRIPTION);
            channel.enableLights(true);
            channel.setLightColor(0xFFD32F2F); // Rojo sismoPA
            channel.enableVibration(true);
            channel.setVibrationPattern(new long[]{0, 250, 150, 250});

            Uri defaultSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            AudioAttributes audioAttributes = new AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_EVENT)
                .build();
            channel.setSound(defaultSound, audioAttributes);

            manager.createNotificationChannel(channel);
            Log.i(TAG, "Canal de notificaciones sismoPA creado exitosamente");
        }
    }

    /**
     * Emite una notificación de prueba local 100% nativa de sismoPA.
     * Utiliza el mismo icono, canal de alta prioridad y color que los avisos sísmicos oficiales.
     */
    public static boolean sendLocalTestNotification(Context context) {
        createNotificationChannel(context);

        Intent intent = new Intent(context, LauncherActivity.class);
        intent.setAction(Intent.ACTION_VIEW);
        intent.setData(Uri.parse("https://sismopa.pages.dev/"));
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pendingIntent = PendingIntent.getActivity(context, TEST_NOTIFICATION_ID, intent, flags);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification_icon)
                .setContentTitle("sismoPA — Notificación Nativa")
                .setContentText("Prueba local exitosa en pa.sismodata.app.")
                .setStyle(new NotificationCompat.BigTextStyle().bigText("Prueba local exitosa en pa.sismodata.app. Alertas nativas oficiales funcionando directamente en Android sin navegador intermediario."))
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setColor(0xFFD32F2F)
                .setAutoCancel(true)
                .setContentIntent(pendingIntent);

        try {
            NotificationManagerCompat.from(context).notify(TEST_NOTIFICATION_ID, builder.build());
            Log.i(TAG, "Notificación local de prueba emitida exitosamente");
            return true;
        } catch (SecurityException se) {
            Log.w(TAG, "Permiso POST_NOTIFICATIONS no concedido para la prueba: " + se.getMessage());
            return false;
        } catch (Exception e) {
            Log.e(TAG, "Error emitiendo notificación local de prueba: " + e.getMessage(), e);
            return false;
        }
    }
}
