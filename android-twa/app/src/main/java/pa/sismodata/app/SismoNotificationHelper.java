package pa.sismodata.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

public final class SismoNotificationHelper {
    public static final String CHANNEL_ID = "sismo_alertas_channel";
    public static final String CHANNEL_NAME = "Alertas de sismos en Panamá";
    public static final String CHANNEL_DESCRIPTION = "Avisos inmediatos oficiales de actividad sísmica reportada por el IGC-UP emitidos por sismoPA.";
    private static final String TAG = "SismoNotifHelper";

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
}
