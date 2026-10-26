/*
 * Copyright 2020 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package pa.sismodata.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;

import com.google.firebase.messaging.FirebaseMessaging;

public class LauncherActivity
        extends com.google.androidbrowserhelper.trusted.LauncherActivity {

    private static final String TAG = "SismoLauncherActivity";
    private static final int RC_NOTIFICATION_PERMISSION = 2026;
    public static final String FCM_TOPIC = "sismos_panama";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.O) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        } else {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        }

        // Crear canal de notificación sismoPA
        SismoNotificationHelper.createNotificationChannel(this);

        // Procesar posibles acciones de consentimiento iniciadas por deep link / web
        handleFcmAction(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleFcmAction(intent);
    }

    private void handleFcmAction(Intent intent) {
        if (intent == null || intent.getData() == null) return;

        Uri data = intent.getData();
        String action = data.getQueryParameter("action");
        if (action == null) return;

        Log.i(TAG, "Acción FCM recibida desde URL: " + action);

        if ("twa_fcm_opt_in".equalsIgnoreCase(action) || "fcm_subscribe".equalsIgnoreCase(action)) {
            // Solicitar permiso POST_NOTIFICATIONS en Android 13+ si aún no se ha otorgado
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, RC_NOTIFICATION_PERMISSION);
                    return;
                }
            }
            executeFcmEnrollment();
        } else if ("twa_fcm_opt_out".equalsIgnoreCase(action) || "fcm_unsubscribe".equalsIgnoreCase(action)) {
            executeFcmRevocation();
        }
    }

    private void executeFcmEnrollment() {
        Log.i(TAG, "Ejecutando consentimiento y suscripción voluntaria FCM");
        FcmPreferences.setOptedIn(this, true);

        try {
            // Suscribirse al topic oficial para sismos de Panamá
            FirebaseMessaging.getInstance().subscribeToTopic(FCM_TOPIC)
                    .addOnCompleteListener(task -> {
                        if (task.isSuccessful()) {
                            Log.i(TAG, "Suscripción al topic FCM exitosa: " + FCM_TOPIC);
                        } else {
                            Log.w(TAG, "Fallo al suscribirse al topic FCM", task.getException());
                        }
                    });

            // Obtener y registrar token de dispositivo
            FirebaseMessaging.getInstance().getToken()
                    .addOnCompleteListener(task -> {
                        if (task.isSuccessful() && task.getResult() != null) {
                            String token = task.getResult();
                            FcmPreferences.setToken(this, token);
                            SismoFirebaseMessagingService.syncTokenWithServer(this, token, true);
                        }
                    });
        } catch (Exception e) {
            Log.w(TAG, "Excepción durante la suscripción FCM: " + e.getMessage());
        }
    }

    private void executeFcmRevocation() {
        Log.i(TAG, "Ejecutando revocación de suscripción FCM");
        FcmPreferences.setOptedIn(this, false);

        try {
            FirebaseMessaging.getInstance().unsubscribeFromTopic(FCM_TOPIC)
                    .addOnCompleteListener(task -> Log.i(TAG, "Desuscripción del topic completada"));

            String token = FcmPreferences.getToken(this);
            if (token != null) {
                SismoFirebaseMessagingService.syncTokenWithServer(this, token, false);
            }
        } catch (Exception e) {
            Log.w(TAG, "Excepción durante la revocación FCM: " + e.getMessage());
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == RC_NOTIFICATION_PERMISSION) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                Log.i(TAG, "Permiso POST_NOTIFICATIONS otorgado por el usuario");
                executeFcmEnrollment();
            } else {
                Log.w(TAG, "Permiso POST_NOTIFICATIONS denegado por el usuario");
                FcmPreferences.setOptedIn(this, false);
            }
        }
    }

    @Override
    protected Uri getLaunchingUrl() {
        Uri uri = super.getLaunchingUrl();

        // Enriquecer la URL de inicio para informar a la PWA de la identidad y estado FCM de sismoPA
        boolean isEnrolled = FcmPreferences.isOptedIn(this);
        Uri.Builder builder = uri.buildUpon();
        builder.appendQueryParameter("platform", "android_twa");
        builder.appendQueryParameter("fcm_status", isEnrolled ? "active" : "inactive");

        return builder.build();
    }
}
