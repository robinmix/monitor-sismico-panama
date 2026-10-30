package pa.sismodata.app;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;

import com.google.firebase.messaging.FirebaseMessaging;

/**
 * Pantalla nativa oficial de consentimiento y configuración de notificaciones sismoPA.
 * Proporciona una interfaz Android directa independiente del navegador web,
 * con gestión compacta de distancia por GPS y recepción nativa FCM.
 */
public class SismoNotificationSettingsActivity extends Activity {
    private static final String TAG = "SismoSettingsActivity";
    private static final int RC_PERMISSION = 3001;
    private static final int RC_LOCATION = 3002;

    private TextView mStatusBadge;
    private TextView mStatusDesc;
    private TextView mErrorDesc;
    private Button mBtnAction;
    private Button mBtnTest;
    private Button mBtnDismiss;

    // Elementos de la tarjeta compacta de Distancia en Notificaciones
    private LinearLayout mDistCard;
    private TextView mDistStatus;
    private Button mBtnGps;
    private LinearLayout mActiveActionRow;
    private Button mBtnUpdateGps;
    private Button mBtnClearLoc;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Asegurar que el canal de notificaciones exista
        SismoNotificationHelper.createNotificationChannel(this);

        setContentView(buildView());
        updateUi();
    }

    @Override
    protected void onResume() {
        super.onResume();
        updateUi();
    }

    private View buildView() {
        ScrollView scrollView = new ScrollView(this);
        scrollView.setBackgroundColor(Color.BLACK); // AMOLED puro

        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(dp(20), dp(24), dp(20), dp(32));

        // Título de la pantalla
        TextView title = new TextView(this);
        title.setText("Notificaciones Sísmicas");
        title.setTextColor(Color.WHITE);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        layout.addView(title);

        TextView subtitle = new TextView(this);
        subtitle.setText("Avisos informativos de sismicidad para Panamá");
        subtitle.setTextColor(Color.parseColor("#9E9E9E"));
        subtitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        subtitle.setPadding(0, dp(4), 0, dp(16));
        layout.addView(subtitle);

        // Tarjeta de Estado FCM
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(16), dp(16), dp(16), dp(16));
        GradientDrawable cardBg = new GradientDrawable();
        cardBg.setColor(Color.parseColor("#10141D"));
        cardBg.setCornerRadius(dp(12));
        cardBg.setStroke(dp(1), Color.parseColor("#1E2536"));
        card.setBackground(cardBg);

        // Badge de estado
        mStatusBadge = new TextView(this);
        mStatusBadge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        mStatusBadge.setTypeface(Typeface.DEFAULT_BOLD);
        mStatusBadge.setPadding(dp(10), dp(4), dp(10), dp(4));
        mStatusBadge.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams badgeParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        badgeParams.bottomMargin = dp(12);
        card.addView(mStatusBadge, badgeParams);

        // Soporte técnico discreto (pulsación prolongada para copiar token si es necesario)
        mStatusBadge.setOnLongClickListener(v -> {
            onCopyTokenClicked();
            return true;
        });

        // Descripción de estado
        mStatusDesc = new TextView(this);
        mStatusDesc.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        mStatusDesc.setTextColor(Color.parseColor("#CFD8DC"));
        mStatusDesc.setLineSpacing(dp(2), 1.15f);
        card.addView(mStatusDesc);

        // Mensaje de error (oculto si no hay error)
        mErrorDesc = new TextView(this);
        mErrorDesc.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        mErrorDesc.setTextColor(Color.parseColor("#EF5350"));
        mErrorDesc.setPadding(0, dp(8), 0, 0);
        mErrorDesc.setVisibility(View.GONE);
        card.addView(mErrorDesc);

        // Botón principal de acción FCM
        mBtnAction = new Button(this);
        mBtnAction.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        mBtnAction.setTypeface(Typeface.DEFAULT_BOLD);
        mBtnAction.setPadding(0, dp(12), 0, dp(12));
        LinearLayout.LayoutParams btnActionParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        btnActionParams.topMargin = dp(16);
        card.addView(mBtnAction, btnActionParams);

        layout.addView(card);

        // Botón para probar notificación de ejemplo
        mBtnTest = new Button(this);
        mBtnTest.setText("Probar notificación de ejemplo");
        mBtnTest.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        mBtnTest.setTextColor(Color.parseColor("#90CAF9"));
        GradientDrawable testBg = new GradientDrawable();
        testBg.setColor(Color.parseColor("#0F172A"));
        testBg.setCornerRadius(dp(8));
        testBg.setStroke(dp(1), Color.parseColor("#1E293B"));
        mBtnTest.setBackground(testBg);
        LinearLayout.LayoutParams testParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        testParams.topMargin = dp(12);

        // =====================================================================
        // TARJETA COMPACTA: DISTANCIA EN NOTIFICACIONES (DISEÑO SOLICITADO)
        // =====================================================================
        mDistCard = new LinearLayout(this);
        mDistCard.setOrientation(LinearLayout.VERTICAL);
        mDistCard.setPadding(dp(14), dp(12), dp(14), dp(12));
        GradientDrawable distCardBg = new GradientDrawable();
        distCardBg.setColor(Color.parseColor("#10141D"));
        distCardBg.setCornerRadius(dp(10));
        distCardBg.setStroke(dp(1), Color.parseColor("#1E2536"));
        mDistCard.setBackground(distCardBg);

        LinearLayout.LayoutParams distCardParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        distCardParams.topMargin = dp(12);

        // Título breve: Distancia en notificaciones
        TextView distTitle = new TextView(this);
        distTitle.setText("Distancia en notificaciones");
        distTitle.setTextColor(Color.WHITE);
        distTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        distTitle.setTypeface(Typeface.DEFAULT_BOLD);
        mDistCard.addView(distTitle);

        // Estado: Desactivada / GPS activado
        mDistStatus = new TextView(this);
        mDistStatus.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        mDistStatus.setPadding(0, dp(4), 0, dp(10));
        mDistCard.addView(mDistStatus);

        // Botón cuando está desactivada: [ACTIVAR GPS]
        mBtnGps = new Button(this);
        mBtnGps.setText("ACTIVAR GPS");
        mBtnGps.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        mBtnGps.setTypeface(Typeface.DEFAULT_BOLD);
        mBtnGps.setTextColor(Color.WHITE);
        GradientDrawable gpsBg = new GradientDrawable();
        gpsBg.setColor(Color.parseColor("#1B5E20"));
        gpsBg.setCornerRadius(dp(8));
        mBtnGps.setBackground(gpsBg);
        LinearLayout.LayoutParams gpsParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        mDistCard.addView(mBtnGps, gpsParams);

        // Fila de botones cuando está activa: [ACTUALIZAR GPS]  [DESACTIVAR]
        mActiveActionRow = new LinearLayout(this);
        mActiveActionRow.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        mActiveActionRow.setVisibility(View.GONE);

        mBtnUpdateGps = new Button(this);
        mBtnUpdateGps.setText("ACTUALIZAR GPS");
        mBtnUpdateGps.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        mBtnUpdateGps.setTypeface(Typeface.DEFAULT_BOLD);
        mBtnUpdateGps.setTextColor(Color.WHITE);
        GradientDrawable updateBg = new GradientDrawable();
        updateBg.setColor(Color.parseColor("#1B5E20"));
        updateBg.setCornerRadius(dp(8));
        mBtnUpdateGps.setBackground(updateBg);
        LinearLayout.LayoutParams updateParams = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1.0f);
        mActiveActionRow.addView(mBtnUpdateGps, updateParams);

        mBtnClearLoc = new Button(this);
        mBtnClearLoc.setText("DESACTIVAR");
        mBtnClearLoc.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        mBtnClearLoc.setTypeface(Typeface.DEFAULT_BOLD);
        mBtnClearLoc.setTextColor(Color.parseColor("#EF5350"));
        GradientDrawable clearBg = new GradientDrawable();
        clearBg.setColor(Color.parseColor("#261C1F"));
        clearBg.setCornerRadius(dp(8));
        clearBg.setStroke(dp(1), Color.parseColor("#5C2028"));
        mBtnClearLoc.setBackground(clearBg);
        LinearLayout.LayoutParams clearParams = new LinearLayout.LayoutParams(
                0, ViewGroup.LayoutParams.WRAP_CONTENT, 1.0f);
        clearParams.leftMargin = dp(8);
        mActiveActionRow.addView(mBtnClearLoc, clearParams);

        mDistCard.addView(mActiveActionRow, rowParams);

        layout.addView(mDistCard, distCardParams);
        layout.addView(mBtnTest, testParams);

        // Tarjeta informativa y de transparencia
        LinearLayout infoCard = new LinearLayout(this);
        infoCard.setOrientation(LinearLayout.VERTICAL);
        infoCard.setPadding(dp(16), dp(16), dp(16), dp(16));
        GradientDrawable infoBg = new GradientDrawable();
        infoBg.setColor(Color.parseColor("#0D111A"));
        infoBg.setCornerRadius(dp(12));
        infoBg.setStroke(dp(1), Color.parseColor("#1B2232"));
        infoCard.setBackground(infoBg);

        LinearLayout.LayoutParams infoParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        infoParams.topMargin = dp(14);

        TextView infoTitle = new TextView(this);
        infoTitle.setText("Información sobre el servicio");
        infoTitle.setTextColor(Color.parseColor("#90CAF9"));
        infoTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        infoTitle.setTypeface(Typeface.DEFAULT_BOLD);
        infoCard.addView(infoTitle);

        TextView infoText = new TextView(this);
        infoText.setText("• Fuente de datos: Instituto de Geociencias de la Universidad de Panamá (IGC-UP).\n\n• sismoPA es una iniciativa comunitaria de monitoreo y divulgación sísmica. No es un sistema de alerta temprana ante terremotos.\n\n• Las coordenadas de ubicación para distancia se procesan exclusivamente en este dispositivo y nunca se transmiten a servidores externos.");
        infoText.setTextColor(Color.parseColor("#90A4AE"));
        infoText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        infoText.setLineSpacing(dp(2), 1.2f);
        infoText.setPadding(0, dp(8), 0, 0);
        infoCard.addView(infoText);

        layout.addView(infoCard, infoParams);

        // Botón volver / cerrar
        mBtnDismiss = new Button(this);
        mBtnDismiss.setText("Volver al Monitor");
        mBtnDismiss.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        mBtnDismiss.setTextColor(Color.parseColor("#B0BEC5"));
        mBtnDismiss.setBackgroundColor(Color.TRANSPARENT);
        LinearLayout.LayoutParams dismissParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        dismissParams.topMargin = dp(12);
        dismissParams.bottomMargin = dp(16);
        layout.addView(mBtnDismiss, dismissParams);

        scrollView.addView(layout);

        // Eventos
        mBtnAction.setOnClickListener(v -> onActionClicked());
        mBtnTest.setOnClickListener(v -> onTestNotificationClicked());
        mBtnGps.setOnClickListener(v -> onGpsLocationClicked());
        mBtnUpdateGps.setOnClickListener(v -> onGpsLocationClicked());
        mBtnClearLoc.setOnClickListener(v -> onClearLocationClicked());
        mBtnDismiss.setOnClickListener(v -> finish());

        return scrollView;
    }

    private void updateUi() {
        updateDistUi();
        FcmPreferences.State state = FcmPreferences.getState(this);

        GradientDrawable badgeBg = new GradientDrawable();
        badgeBg.setCornerRadius(dp(6));

        boolean isTrulyActive = FcmPreferences.isOptedIn(this);

        switch (state) {
            case ACTIVO:
                if (!isTrulyActive) {
                    mStatusBadge.setText("SINCRONIZANDO...");
                    mStatusBadge.setTextColor(Color.WHITE);
                    badgeBg.setColor(Color.parseColor("#1565C0"));
                    mStatusBadge.setBackground(badgeBg);
                    mStatusDesc.setText("Confirmando suscripción con los servidores de Firebase...");
                    mErrorDesc.setVisibility(View.GONE);

                    mBtnAction.setText("Sincronizando...");
                    mBtnAction.setEnabled(false);

                    executeSubscription();
                    break;
                }
                mStatusBadge.setText("ALERTAS ACTIVAS");
                mStatusBadge.setTextColor(Color.parseColor("#E8F5E9"));
                badgeBg.setColor(Color.parseColor("#2E7D32"));
                mStatusBadge.setBackground(badgeBg);
                mStatusDesc.setText("Notificaciones activas. Recibirás avisos informativos cuando el IGC-UP publique nuevos reportes sísmicos en Panamá.");
                mErrorDesc.setVisibility(View.GONE);

                mBtnAction.setText("Desactivar Alertas");
                mBtnAction.setTextColor(Color.WHITE);
                GradientDrawable btnDeactBg = new GradientDrawable();
                btnDeactBg.setColor(Color.parseColor("#37474F"));
                btnDeactBg.setCornerRadius(dp(8));
                mBtnAction.setBackground(btnDeactBg);
                mBtnAction.setEnabled(true);
                break;

            case SUSCRIBIENDO:
                mStatusBadge.setText("CONECTANDO...");
                mStatusBadge.setTextColor(Color.WHITE);
                badgeBg.setColor(Color.parseColor("#1565C0"));
                mStatusBadge.setBackground(badgeBg);
                mStatusDesc.setText("Conectando con el servicio de alertas y verificando suscripción...");
                mErrorDesc.setVisibility(View.GONE);

                mBtnAction.setText("Conectando...");
                mBtnAction.setEnabled(false);
                break;

            case SOLICITANDO_PERMISO:
                mStatusBadge.setText("SOLICITANDO PERMISO");
                mStatusBadge.setTextColor(Color.WHITE);
                badgeBg.setColor(Color.parseColor("#E65100"));
                mStatusBadge.setBackground(badgeBg);
                mStatusDesc.setText("Esperando confirmación del permiso del sistema Android...");
                mErrorDesc.setVisibility(View.GONE);

                mBtnAction.setText("Esperando permiso...");
                mBtnAction.setEnabled(false);
                break;

            case ERROR:
                mStatusBadge.setText("ERROR");
                mStatusBadge.setTextColor(Color.WHITE);
                badgeBg.setColor(Color.parseColor("#C62828"));
                mStatusBadge.setBackground(badgeBg);
                boolean wasDeactivating = FcmPreferences.isTopicSubscribed(this);
                if (wasDeactivating) {
                    mStatusDesc.setText("Ocurrió un error al desactivar las alertas en los servidores.");
                    mBtnAction.setText("Reintentar Desactivación");
                } else {
                    mStatusDesc.setText("No se pudo completar la activación de las notificaciones.");
                    mBtnAction.setText("Reintentar Activación");
                }
                String err = FcmPreferences.getLastError(this);
                if (err != null && !err.isEmpty()) {
                    mErrorDesc.setText("Detalle: " + err);
                    mErrorDesc.setVisibility(View.VISIBLE);
                } else {
                    mErrorDesc.setVisibility(View.GONE);
                }
                GradientDrawable btnErrBg = new GradientDrawable();
                btnErrBg.setColor(Color.parseColor("#D32F2F"));
                btnErrBg.setCornerRadius(dp(8));
                mBtnAction.setBackground(btnErrBg);
                mBtnAction.setTextColor(Color.WHITE);
                mBtnAction.setEnabled(true);
                break;

            case REVOCANDO:
                mStatusBadge.setText("DESACTIVANDO...");
                mStatusBadge.setTextColor(Color.WHITE);
                badgeBg.setColor(Color.parseColor("#546E7A"));
                mStatusBadge.setBackground(badgeBg);
                mStatusDesc.setText("Cancelando suscripción en los servidores...");
                mErrorDesc.setVisibility(View.GONE);

                mBtnAction.setText("Desactivando...");
                mBtnAction.setEnabled(false);
                break;

            case DESACTIVADO:
            default:
                mStatusBadge.setText("ALERTAS DESACTIVADAS");
                mStatusBadge.setTextColor(Color.parseColor("#CFD8DC"));
                badgeBg.setColor(Color.parseColor("#37474F"));
                mStatusBadge.setBackground(badgeBg);
                mStatusDesc.setText("Activa las alertas informativas para recibir notificaciones inmediatas de sismos en Panamá.");
                mErrorDesc.setVisibility(View.GONE);

                mBtnAction.setText("Activar Alertas Sísmicas");
                mBtnAction.setTextColor(Color.WHITE);
                GradientDrawable btnActBg = new GradientDrawable();
                btnActBg.setColor(Color.parseColor("#1565C0"));
                btnActBg.setCornerRadius(dp(8));
                mBtnAction.setBackground(btnActBg);
                mBtnAction.setEnabled(true);
                break;
        }
    }

    private void updateDistUi() {
        if (mDistCard == null) return;
        boolean isActive = FcmPreferences.isDistancePersonalizationActive(this);

        if (!isActive) {
            mDistStatus.setText("Estado: Desactivada");
            mDistStatus.setTextColor(Color.parseColor("#90A4AE"));
            mBtnGps.setVisibility(View.VISIBLE);
            mActiveActionRow.setVisibility(View.GONE);
        } else {
            mDistStatus.setText("Estado: GPS activado");
            mDistStatus.setTextColor(Color.parseColor("#81C784"));
            mBtnGps.setVisibility(View.GONE);
            mActiveActionRow.setVisibility(View.VISIBLE);
        }
    }

    // =========================================================================
    // FLUJO COMPLETO GPS (SOLICITUD DE PERMISO, CAPTURA Y PERSISTENCIA)
    // =========================================================================
    private void onGpsLocationClicked() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            boolean hasFine = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
            boolean hasCoarse = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
            if (!hasFine && !hasCoarse) {
                requestPermissions(new String[]{
                        Manifest.permission.ACCESS_FINE_LOCATION,
                        Manifest.permission.ACCESS_COARSE_LOCATION
                }, RC_LOCATION);
                return;
            }
        }
        acquireDeviceLocation();
    }

    private void acquireDeviceLocation() {
        LocationManager lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) {
            Toast.makeText(this, "Servicio de ubicación no disponible", Toast.LENGTH_SHORT).show();
            return;
        }

        boolean gpsEnabled = false;
        boolean networkEnabled = false;
        try {
            gpsEnabled = lm.isProviderEnabled(LocationManager.GPS_PROVIDER);
        } catch (Exception ignored) {}
        try {
            networkEnabled = lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Exception ignored) {}

        if (!gpsEnabled && !networkEnabled) {
            Toast.makeText(this, "Ubicación del dispositivo desactivada. Actívala en los Ajustes de Android.", Toast.LENGTH_LONG).show();
            return;
        }

        // 1. Probar última ubicación conocida
        Location bestLoc = null;
        try {
            if (gpsEnabled) {
                Location l = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER);
                if (l != null) bestLoc = l;
            }
            if (networkEnabled) {
                Location l = lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
                if (l != null && (bestLoc == null || l.getTime() > bestLoc.getTime())) {
                    bestLoc = l;
                }
            }
        } catch (SecurityException ignored) {}

        long now = System.currentTimeMillis();
        // Si hay una ubicación reciente (últimos 30 minutos), utilizarla directamente
        if (bestLoc != null && (now - bestLoc.getTime()) < 30 * 60 * 1000L) {
            saveAndApplyLocation(bestLoc);
            return;
        }

        // 2. Solicitar fix de satélite / red
        Toast.makeText(this, "Consultando señal GPS…", Toast.LENGTH_SHORT).show();
        final Location fallbackLoc = bestLoc;
        final LocationListener listener = new LocationListener() {
            @Override
            public void onLocationChanged(@NonNull Location location) {
                try {
                    lm.removeUpdates(this);
                } catch (SecurityException ignored) {}
                saveAndApplyLocation(location);
            }

            @Override
            public void onStatusChanged(String provider, int status, Bundle extras) {}
            @Override
            public void onProviderEnabled(@NonNull String provider) {}
            @Override
            public void onProviderDisabled(@NonNull String provider) {}
        };

        try {
            String provider = gpsEnabled ? LocationManager.GPS_PROVIDER : LocationManager.NETWORK_PROVIDER;
            lm.requestSingleUpdate(provider, listener, Looper.getMainLooper());

            // Timeout de seguridad de 8 segundos si la señal tarda
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                try {
                    lm.removeUpdates(listener);
                } catch (SecurityException ignored) {}
                if (!FcmPreferences.isDistancePersonalizationActive(this)) {
                    if (fallbackLoc != null) {
                        saveAndApplyLocation(fallbackLoc);
                    } else {
                        Toast.makeText(this, "No se pudo obtener señal GPS satelital. Inténtalo al aire libre.", Toast.LENGTH_LONG).show();
                    }
                }
            }, 8000);
        } catch (SecurityException se) {
            Toast.makeText(this, "Permiso de ubicación no disponible", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            if (fallbackLoc != null) {
                saveAndApplyLocation(fallbackLoc);
            } else {
                Toast.makeText(this, "Error consultando GPS: " + e.getMessage(), Toast.LENGTH_SHORT).show();
            }
        }
    }

    private void saveAndApplyLocation(Location loc) {
        if (loc == null) return;
        double lat = loc.getLatitude();
        double lon = loc.getLongitude();
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
            Toast.makeText(this, "Coordenadas recibidas inválidas", Toast.LENGTH_SHORT).show();
            return;
        }
        FcmPreferences.setUserLocation(this, lat, lon, "GPS", "");
        updateDistUi();
        Toast.makeText(this, "GPS activado. Distancia calculada localmente en tu teléfono.", Toast.LENGTH_SHORT).show();
    }

    private void onClearLocationClicked() {
        FcmPreferences.clearUserLocation(this);
        updateDistUi();
        Toast.makeText(this, "Distancia por GPS desactivada", Toast.LENGTH_SHORT).show();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);

        if (requestCode == RC_LOCATION) {
            boolean granted = false;
            for (int res : grantResults) {
                if (res == PackageManager.PERMISSION_GRANTED) {
                    granted = true;
                    break;
                }
            }
            if (granted) {
                acquireDeviceLocation();
            } else {
                Toast.makeText(this, "Permiso de ubicación no concedido", Toast.LENGTH_SHORT).show();
                updateDistUi();
            }
            return;
        }

        if (requestCode == RC_PERMISSION) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                Log.i(TAG, "Permiso POST_NOTIFICATIONS concedido por el usuario");
                executeSubscription();
            } else {
                Log.w(TAG, "Permiso POST_NOTIFICATIONS denegado por el usuario");
                FcmPreferences.setState(this, FcmPreferences.State.ERROR);
                FcmPreferences.setLastError(this, "Permiso de notificaciones denegado en ajustes de Android.");
                updateUi();
                Toast.makeText(this, "Permiso de notificaciones denegado. Puedes activarlo en los Ajustes del sistema.", Toast.LENGTH_LONG).show();
            }
        }
    }

    private void onActionClicked() {
        FcmPreferences.State state = FcmPreferences.getState(this);
        if (state == FcmPreferences.State.ACTIVO) {
            executeRevocation();
        } else {
            startSubscriptionFlow();
        }
    }

    private void startSubscriptionFlow() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            int permCheck = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS);
            if (permCheck != PackageManager.PERMISSION_GRANTED) {
                FcmPreferences.setState(this, FcmPreferences.State.SOLICITANDO_PERMISO);
                updateUi();
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, RC_PERMISSION);
                return;
            }
        }
        executeSubscription();
    }

    private void executeSubscription() {
        FcmPreferences.setState(this, FcmPreferences.State.SUSCRIBIENDO);
        updateUi();

        try {
            FirebaseMessaging.getInstance().setAutoInitEnabled(true);
            FirebaseMessaging.getInstance().subscribeToTopic(LauncherActivity.FCM_TOPIC)
                    .addOnCompleteListener(this, subTask -> {
                        if (subTask.isSuccessful()) {
                            Log.i(TAG, "Suscripción nativa al topic sismos_panama exitosa");
                            FcmPreferences.setTopicSubscribed(this, true);

                            FirebaseMessaging.getInstance().getToken()
                                    .addOnCompleteListener(this, tokenTask -> {
                                        if (tokenTask.isSuccessful() && tokenTask.getResult() != null) {
                                            String token = tokenTask.getResult();
                                            Log.i(TAG, "Token FCM obtenido internamente con éxito");
                                            FcmPreferences.setToken(this, token);
                                            FcmPreferences.setState(this, FcmPreferences.State.ACTIVO);
                                            FcmPreferences.setDecidedConsent(this, true);
                                            FcmPreferences.setLastError(this, "");

                                            updateUi();
                                            Toast.makeText(this, "¡Alertas de sismoPA activadas!", Toast.LENGTH_SHORT).show();
                                        } else {
                                            Exception e = tokenTask.getException();
                                            String errMsg = (e != null) ? e.getMessage() : "Error obteniendo token";
                                            Log.w(TAG, "Fallo al obtener token FCM: " + errMsg);
                                            FcmPreferences.setState(this, FcmPreferences.State.ERROR);
                                            FcmPreferences.setLastError(this, "No se pudo obtener el token de mensajería: " + errMsg);
                                            updateUi();
                                        }
                                    });
                        } else {
                            Exception e = subTask.getException();
                            String errMsg = (e != null) ? e.getMessage() : "Error suscribiendo al topic";
                            Log.w(TAG, "Fallo al suscribir al topic FCM: " + errMsg);
                            FcmPreferences.setState(this, FcmPreferences.State.ERROR);
                            FcmPreferences.setLastError(this, "No se pudo conectar al canal de sismos: " + errMsg);
                            FirebaseMessaging.getInstance().setAutoInitEnabled(false);
                            updateUi();
                        }
                    });
        } catch (Exception e) {
            Log.e(TAG, "Excepción durante suscripción FCM: " + e.getMessage(), e);
            FcmPreferences.setState(this, FcmPreferences.State.ERROR);
            FcmPreferences.setLastError(this, e.getMessage());
            updateUi();
        }
    }

    private void executeRevocation() {
        FcmPreferences.setState(this, FcmPreferences.State.REVOCANDO);
        updateUi();

        try {
            FirebaseMessaging.getInstance().unsubscribeFromTopic(LauncherActivity.FCM_TOPIC)
                    .addOnCompleteListener(this, unsubTask -> {
                        if (!unsubTask.isSuccessful()) {
                            Exception e = unsubTask.getException();
                            String errMsg = (e != null) ? e.getMessage() : "Fallo de conexión con Firebase";
                            Log.w(TAG, "Fallo al desuscribir del topic FCM: " + errMsg);
                            FcmPreferences.setState(this, FcmPreferences.State.ERROR);
                            FcmPreferences.setLastError(this, "No se pudo cancelar la suscripción en Firebase: " + errMsg);
                            updateUi();
                            Toast.makeText(this, "Error al desactivar: " + errMsg, Toast.LENGTH_LONG).show();
                            return;
                        }

                        Log.i(TAG, "Desuscripción de topic FCM exitosa: " + LauncherActivity.FCM_TOPIC);
                        FcmPreferences.setTopicSubscribed(this, false);

                        FirebaseMessaging.getInstance().deleteToken()
                                .addOnCompleteListener(this, delTask -> {
                                    if (!delTask.isSuccessful()) {
                                        Exception e = delTask.getException();
                                        Log.w(TAG, "Aviso: deleteToken reportó error pero el topic ya fue cancelado: " + (e != null ? e.getMessage() : ""));
                                    }
                                    FirebaseMessaging.getInstance().setAutoInitEnabled(false);
                                    FcmPreferences.setToken(this, null);
                                    FcmPreferences.setState(this, FcmPreferences.State.DESACTIVADO);
                                    FcmPreferences.setDecidedConsent(this, true);
                                    FcmPreferences.setLastError(this, "");

                                    updateUi();
                                    Toast.makeText(this, "Alertas desactivadas correctamente", Toast.LENGTH_SHORT).show();
                                });
                    });
        } catch (Exception e) {
            Log.e(TAG, "Excepción durante revocación FCM: " + e.getMessage(), e);
            FcmPreferences.setState(this, FcmPreferences.State.ERROR);
            FcmPreferences.setLastError(this, e.getMessage());
            updateUi();
        }
    }

    private void onTestNotificationClicked() {
        boolean sent = SismoNotificationHelper.sendLocalTestNotification(this);
        if (sent) {
            Toast.makeText(this, "Notificación nativa de prueba emitida", Toast.LENGTH_SHORT).show();
        } else {
            Toast.makeText(this, "No se pudo emitir la prueba. Verifica el permiso de notificaciones.", Toast.LENGTH_LONG).show();
        }
    }

    private void onCopyTokenClicked() {
        String token = FcmPreferences.getToken(this);
        if (token != null && !token.isEmpty()) {
            ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = ClipData.newPlainText("sismoPA FCM Token", token);
            if (clipboard != null) {
                clipboard.setPrimaryClip(clip);
                Toast.makeText(this, "Token copiado al portapapeles", Toast.LENGTH_SHORT).show();
            }
        }
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics());
    }
}
