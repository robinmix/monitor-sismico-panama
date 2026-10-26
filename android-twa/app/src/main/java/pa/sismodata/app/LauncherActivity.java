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

import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.browser.customtabs.CustomTabsCallback;
import androidx.browser.customtabs.CustomTabsSession;

import java.lang.reflect.Field;

public class LauncherActivity
        extends com.google.androidbrowserhelper.trusted.LauncherActivity {

    private static final String TAG = "SismoLauncherActivity";
    public static final String FCM_TOPIC = "sismos_panama";
    public static final String TWA_ORIGIN = "https://sismopa.pages.dev";

    private CustomTabsSession mCustomTabsSession;
    private boolean mIsRelationshipValidated = false;
    private boolean mIsMessageChannelReady = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.O) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        } else {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        }

        // Crear canal de notificación nativo sismoPA
        SismoNotificationHelper.createNotificationChannel(this);

        // Procesar deep links nativos sismopa://
        handleIncomingIntent(getIntent());

        // En el primer arranque, invitar de forma transparente a configurar las alertas nativas
        if (!FcmPreferences.hasDecidedConsent(this)) {
            Intent settingsIntent = new Intent(this, SismoNotificationSettingsActivity.class);
            settingsIntent.putExtra("first_run", true);
            startActivity(settingsIntent);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncomingIntent(intent);
    }

    private void handleIncomingIntent(Intent intent) {
        if (intent == null || intent.getData() == null) return;

        Uri data = intent.getData();
        String scheme = data.getScheme();
        String host = data.getHost();

        Log.i(TAG, "Intent recibido con URI: " + data);

        // Si es un enlace nativo de sismoPA para ajustes de notificaciones
        if ("sismopa".equalsIgnoreCase(scheme)) {
            Intent settingsIntent = new Intent(this, SismoNotificationSettingsActivity.class);
            startActivity(settingsIntent);
        }
    }

    @Override
    protected CustomTabsCallback getCustomTabsCallback() {
        return new CustomTabsCallback() {
            @Override
            public void onRelationshipValidationResult(int relation, @NonNull Uri requestedOrigin, boolean result, @Nullable Bundle extras) {
                super.onRelationshipValidationResult(relation, requestedOrigin, result, extras);
                Log.i(TAG, "Validación DAL de origen: " + requestedOrigin + ", éxito: " + result);

                if (result && requestedOrigin != null && "sismopa.pages.dev".equalsIgnoreCase(requestedOrigin.getHost())) {
                    mIsRelationshipValidated = true;
                    initPostMessageChannel(requestedOrigin);
                }
            }

            @Override
            public void onMessageChannelReady(@Nullable Bundle extras) {
                super.onMessageChannelReady(extras);
                Log.i(TAG, "Canal TWA postMessage listo");
                mIsMessageChannelReady = true;
                sendFcmStatusToWeb();
            }

            @Override
            public void onPostMessage(@NonNull String message, @Nullable Bundle extras) {
                super.onPostMessage(message, extras);
                Log.i(TAG, "Mensaje postMessage recibido desde la web: " + message);
                handleWebPostMessage(message);
            }
        };
    }

    private void initPostMessageChannel(Uri origin) {
        CustomTabsSession session = getSessionFromLauncher();
        if (session != null) {
            mCustomTabsSession = session;
            boolean channelRequested = session.requestPostMessageChannel(origin);
            Log.i(TAG, "requestPostMessageChannel para " + origin + " resultado: " + channelRequested);
        }
    }

    private CustomTabsSession getSessionFromLauncher() {
        if (mCustomTabsSession != null) return mCustomTabsSession;
        try {
            Field launcherField = com.google.androidbrowserhelper.trusted.LauncherActivity.class.getDeclaredField("mTwaLauncher");
            launcherField.setAccessible(true);
            Object twaLauncher = launcherField.get(this);
            if (twaLauncher != null) {
                Field sessionField = com.google.androidbrowserhelper.trusted.TwaLauncher.class.getDeclaredField("mSession");
                sessionField.setAccessible(true);
                return (CustomTabsSession) sessionField.get(twaLauncher);
            }
        } catch (Exception e) {
            Log.d(TAG, "mSession aún no establecida en TwaLauncher: " + e.getMessage());
        }
        return null;
    }

    private void sendFcmStatusToWeb() {
        CustomTabsSession session = getSessionFromLauncher();
        if (session != null) {
            boolean active = FcmPreferences.isOptedIn(this);
            String stateName = FcmPreferences.getState(this).name();
            String json = "{\"type\":\"SISMO_FCM_STATUS\",\"active\":" + active + ",\"state\":\"" + stateName + "\"}";
            session.postMessage(json, null);
            Log.i(TAG, "Estado FCM enviado a la web vía postMessage: " + json);
        }
    }

    private void handleWebPostMessage(String message) {
        if (message == null) return;

        if (message.contains("GET_FCM_STATUS")) {
            sendFcmStatusToWeb();
        } else if (message.contains("OPEN_SETTINGS") || message.contains("OPEN_NOTIFICATIONS")) {
            Intent settingsIntent = new Intent(this, SismoNotificationSettingsActivity.class);
            startActivity(settingsIntent);
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
