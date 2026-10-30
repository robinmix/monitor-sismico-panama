package pa.sismodata.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.location.Location;
import android.location.LocationManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
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
 * Proporciona una interfaz Android directa independiente del navegador web (Chrome/Brave),
 * garantizando que ninguna autorización se base en parámetros de URL manipulables.
 * Versión 1.0.8: Interfaz limpia de producción, sin exposición técnica de tokens en pantalla.
 */
public class SismoNotificationSettingsActivity extends Activity {
    private static final String TAG = "SismoSettingsActivity";
    private static final int RC_PERMISSION = 3001;

    private TextView mStatusBadge;
    private TextView mStatusDesc;
    private TextView mErrorDesc;
    private Button mBtnAction;
    private Button mBtnTest;
    private Button mBtnDismiss;

    // Elementos de la tarjeta de Distancia en Notificaciones
    private LinearLayout mDistCard;
    private TextView mDistBadge;
    private TextView mDistDesc;
    private Button mBtnGps;
    private Button mBtnZone;
    private Button mBtnClearLoc;
    private static final int RC_LOCATION = 3002;

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
        scrollView.setBackgroundColor(Color.parseColor("#05070B"));
        scrollView.setFillViewport(true);

        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(dp(20), dp(24), dp(20), dp(24));

        // Título de la aplicación
        TextView title = new TextView(this);
        title.setText("sismoPA — Alertas Sísmicas");
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

        // Tarjeta de Estado
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

        // Soporte técnico discreto (pulsación prolongada para copiar token solo si soporte técnico lo requiere)
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

        // Botón principal de acción
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
        testParams.topMargin = dp(14);
                // Tarjeta de Personalización por Distancia (sismoPA)
        mDistCard = new LinearLayout(this);
        mDistCard.setOrientation(LinearLayout.VERTICAL);
        mDistCard.setPadding(dp(16), dp(16), dp(16), dp(16));
        GradientDrawable distCardBg = new GradientDrawable();
        distCardBg.setColor(Color.parseColor("#10141D"));
        distCardBg.setCornerRadius(dp(12));
        distCardBg.setStroke(dp(1), Color.parseColor("#1E2536"));
        mDistCard.setBackground(distCardBg);

        LinearLayout.LayoutParams distCardParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        distCardParams.topMargin = dp(14);

        TextView distTitle = new TextView(this);
        distTitle.setText("Distancia en mis notificaciones");
        distTitle.setTextColor(Color.WHITE);
        distTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        distTitle.setTypeface(Typeface.DEFAULT_BOLD);
        mDistCard.addView(distTitle);

        mDistBadge = new TextView(this);
        mDistBadge.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        mDistBadge.setTypeface(Typeface.DEFAULT_BOLD);
        mDistBadge.setPadding(dp(8), dp(3), dp(8), dp(3));
        LinearLayout.LayoutParams distBadgeParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        distBadgeParams.topMargin = dp(8);
        distBadgeParams.bottomMargin = dp(8);
        mDistCard.addView(mDistBadge, distBadgeParams);

        mDistDesc = new TextView(this);
        mDistDesc.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        mDistDesc.setTextColor(Color.parseColor("#CFD8DC"));
        mDistDesc.setLineSpacing(dp(2), 1.15f);
        mDistCard.addView(mDistDesc);

        // Botón GPS
        mBtnGps = new Button(this);
        mBtnGps.setText("Usar mi ubicación actual (GPS)");
        mBtnGps.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        mBtnGps.setTextColor(Color.WHITE);
        GradientDrawable gpsBg = new GradientDrawable();
        gpsBg.setColor(Color.parseColor("#1B5E20"));
        gpsBg.setCornerRadius(dp(8));
        mBtnGps.setBackground(gpsBg);
        LinearLayout.LayoutParams gpsParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        gpsParams.topMargin = dp(12);
        mDistCard.addView(mBtnGps, gpsParams);

        // Botón Zona Fija
        mBtnZone = new Button(this);
        mBtnZone.setText("Elegir provincia o zona fija");
        mBtnZone.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        mBtnZone.setTextColor(Color.parseColor("#90CAF9"));
        GradientDrawable zoneBg = new GradientDrawable();
        zoneBg.setColor(Color.parseColor("#152238"));
        zoneBg.setCornerRadius(dp(8));
        zoneBg.setStroke(dp(1), Color.parseColor("#1E3A5F"));
        mBtnZone.setBackground(zoneBg);
        LinearLayout.LayoutParams zoneParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        zoneParams.topMargin = dp(8);
        mDistCard.addView(mBtnZone, zoneParams);

        // Botón Desactivar
        mBtnClearLoc = new Button(this);
        mBtnClearLoc.setText("Desactivar distancia (formato general)");
        mBtnClearLoc.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        mBtnClearLoc.setTextColor(Color.parseColor("#90A4AE"));
        mBtnClearLoc.setBackgroundColor(Color.TRANSPARENT);
        LinearLayout.LayoutParams clearParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        clearParams.topMargin = dp(6);
        mDistCard.addView(mBtnClearLoc, clearParams);

        layout.addView(mDistCard, distCardParams);

        layout.addView(mBtnTest, testParams);

        // Tarjeta informativa y de transparencia (producción limpia)
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
        infoText.setText("• Fuente de datos: Instituto de Geociencias de la Universidad de Panamá (IGC-UP).\n\n• sismoPA es una iniciativa comunitaria de monitoreo y divulgación sísmica. No es una entidad gubernamental oficial ni un sistema de alerta temprana ante terremotos (no detecta movimientos con anticipación).\n\n• La entrega puntual depende de los servicios de Google, la conectividad del dispositivo y las configuraciones de ahorro de energía del sistema operativo.");
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
        mBtnZone.setOnClickListener(v -> onZoneSelectClicked());
        mBtnClearLoc.setOnClickListener(v -> onClearLocationClicked());
        mBtnDismiss.setOnClickListener(v -> finish());

        return scrollView;
    }

    private void updateUi() {
        updateDistUi();
        FcmPreferences.State state = FcmPreferences.getState(this);

        // Renderizado según estado
        GradientDrawable badgeBg = new GradientDrawable();
        badgeBg.setCornerRadius(dp(6));

        boolean isTrulyActive = FcmPreferences.isOptedIn(this);

        switch (state) {
            case ACTIVO:
                if (!isTrulyActive) {
                    // Si el estado interno dice ACTIVO pero falta confirmación de topic o token de Firebase,
                    // NUNCA indicar «ACTIVADAS». Mostrar «SINCRONIZANDO...» y confirmar con Firebase.
                    mStatusBadge.setText("SINCRONIZANDO...");
                    mStatusBadge.setTextColor(Color.WHITE);
                    badgeBg.setColor(Color.parseColor("#1565C0"));
                    mStatusBadge.setBackground(badgeBg);
                    mStatusDesc.setText("Confirmando suscripción con los servidores de Firebase...");
                    mErrorDesc.setVisibility(View.GONE);

                    mBtnAction.setText("Sincronizando...");
                    mBtnAction.setEnabled(false);

                    // Reintentar confirmación de suscripción
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
                    mStatusDesc.setText("No se pudo cancelar la suscripción con Firebase. Comprueba tu conexión e intenta nuevamente.");
                    mBtnAction.setText("Reintentar Desactivación");
                } else {
                    mStatusDesc.setText("Ocurrió un inconveniente al conectar con el servicio sísmico. Puedes intentar nuevamente.");
                    mBtnAction.setText("Reintentar Activación");
                }
                String err = FcmPreferences.getLastError(this);
                if (!err.isEmpty()) {
                    mErrorDesc.setText("Detalle: " + err);
                    mErrorDesc.setVisibility(View.VISIBLE);
                } else {
                    mErrorDesc.setVisibility(View.GONE);
                }

                mBtnAction.setTextColor(Color.WHITE);
                GradientDrawable btnErrBg = new GradientDrawable();
                btnErrBg.setColor(Color.parseColor("#D32F2F"));
                btnErrBg.setCornerRadius(dp(8));
                mBtnAction.setBackground(btnErrBg);
                mBtnAction.setEnabled(true);
                break;

            case REVOCANDO:
                mStatusBadge.setText("DESACTIVANDO...");
                mStatusBadge.setTextColor(Color.WHITE);
                badgeBg.setColor(Color.parseColor("#455A64"));
                mStatusBadge.setBackground(badgeBg);
                mStatusDesc.setText("Cancelando suscripción de alertas sísmicas...");
                mErrorDesc.setVisibility(View.GONE);

                mBtnAction.setText("Desactivando...");
                mBtnAction.setEnabled(false);
                break;

            case DESACTIVADO:
            default:
                mStatusBadge.setText("DESACTIVADAS");
                mStatusBadge.setTextColor(Color.parseColor("#ECEFF1"));
                badgeBg.setColor(Color.parseColor("#37474F"));
                mStatusBadge.setBackground(badgeBg);
                mStatusDesc.setText("Activa las alertas informativas para recibir notificaciones cuando ocurra un evento sísmico en Panamá reportado por el IGC-UP.");
                mErrorDesc.setVisibility(View.GONE);

                mBtnAction.setText("Activar Alertas Sísmicas");
                mBtnAction.setTextColor(Color.WHITE);
                GradientDrawable btnActBg = new GradientDrawable();
                btnActBg.setColor(Color.parseColor("#D32F2F"));
                btnActBg.setCornerRadius(dp(8));
                mBtnAction.setBackground(btnActBg);
                mBtnAction.setEnabled(true);
                break;
        }
    }

    private void onActionClicked() {
        FcmPreferences.State current = FcmPreferences.getState(this);
        if (current == FcmPreferences.State.ACTIVO) {
            executeRevocation();
        } else if (current == FcmPreferences.State.ERROR && FcmPreferences.isTopicSubscribed(this)) {
            executeRevocation();
        } else {
            initiateEnrollment();
        }
    }

    private void initiateEnrollment() {
        Log.i(TAG, "Iniciando proceso voluntario de activación de notificaciones");

        // Android 13+ (API 33+): Comprobar permiso POST_NOTIFICATIONS
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                FcmPreferences.setState(this, FcmPreferences.State.SOLICITANDO_PERMISO);
                updateUi();
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, RC_PERMISSION);
                return;
            }
        }

        executeSubscription();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == RC_PERMISSION) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                Log.i(TAG, "Permiso POST_NOTIFICATIONS concedido por el usuario");
                executeSubscription();
            } else {
                Log.w(TAG, "Permiso POST_NOTIFICATIONS denegado por el usuario");
                FcmPreferences.setState(this, FcmPreferences.State.ERROR);
                FcmPreferences.setLastError(this, "Permiso de notificaciones denegado en ajustes de Android.");
                FcmPreferences.setDecidedConsent(this, true);
                updateUi();
            }
        }
    }

    private void executeSubscription() {
        FcmPreferences.setState(this, FcmPreferences.State.SUSCRIBIENDO);
        updateUi();

        try {
            FirebaseMessaging.getInstance().setAutoInitEnabled(true);

            // 1. Suscribirse al topic oficial sismos_panama
            FirebaseMessaging.getInstance().subscribeToTopic(LauncherActivity.FCM_TOPIC)
                    .addOnCompleteListener(this, subTask -> {
                        if (subTask.isSuccessful()) {
                            Log.i(TAG, "Suscripción a topic FCM exitosa: " + LauncherActivity.FCM_TOPIC);
                            FcmPreferences.setTopicSubscribed(this, true);

                            // 2. Obtener token del dispositivo internamente para enrollamiento en cliente
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

    private void updateDistUi() {
        if (mDistCard == null) return;
        boolean isActive = FcmPreferences.isDistancePersonalizationActive(this);
        GradientDrawable bBg = new GradientDrawable();
        bBg.setCornerRadius(dp(6));

        if (!isActive) {
            mDistBadge.setText("DISTANCIA DESACTIVADA");
            mDistBadge.setTextColor(Color.parseColor("#CFD8DC"));
            bBg.setColor(Color.parseColor("#263238"));
            mDistBadge.setBackground(bBg);
            mDistDesc.setText("Recibirás el formato general (ej. M3.5 · Nuevo sismo · 60 km al sureste de Soná). Puedes activar la distancia aproximada para saber qué tan lejos ocurrió de ti.");
            mBtnClearLoc.setVisibility(View.GONE);
        } else {
            String mode = FcmPreferences.getUserLocationMode(this);
            long updatedAt = FcmPreferences.getUserLocationUpdatedAt(this);
            long ageMs = System.currentTimeMillis() - updatedAt;
            String zoneName = FcmPreferences.getUserLocationZoneName(this);

            if ("ZONA".equalsIgnoreCase(mode)) {
                mDistBadge.setText("ZONA: " + (zoneName.isEmpty() ? "SELECCIONADA" : zoneName.toUpperCase()));
                mDistBadge.setTextColor(Color.parseColor("#E1F5FE"));
                bBg.setColor(Color.parseColor("#0277BD"));
                mDistBadge.setBackground(bBg);
                mDistDesc.setText("Notificaciones mostrarán 'de tu zona' (ej. M3.5 · 42 km de tu zona). Las coordenadas de referencia están guardadas solo en este dispositivo.");
            } else {
                if (ageMs <= 48L * 3600 * 1000L) {
                    mDistBadge.setText("GPS ACTIVO (DE TI)");
                    mDistBadge.setTextColor(Color.parseColor("#E8F5E9"));
                    bBg.setColor(Color.parseColor("#2E7D32"));
                    mDistBadge.setBackground(bBg);
                    mDistDesc.setText("Notificaciones mostrarán 'de ti' (ej. M3.5 · 42 km de ti). Las coordenadas están truncadas a 3 decimales (~110m) para proteger tu privacidad.");
                } else {
                    mDistBadge.setText("GPS ANTERIOR (DE TU ZONA)");
                    mDistBadge.setTextColor(Color.parseColor("#FFF8E1"));
                    bBg.setColor(Color.parseColor("#F57F17"));
                    mDistBadge.setBackground(bBg);
                    mDistDesc.setText("Tu última posición GPS tiene más de 48h. Las alertas mostrarán 'de tu zona'. Toca 'Usar mi ubicación actual' para actualizarla.");
                }
            }
            mBtnClearLoc.setVisibility(View.VISIBLE);
        }
    }

    private void onGpsLocationClicked() {
        // En la arquitectura TWA oficial de sismoPA, la ubicación GPS se adquiere
        // de forma interactiva en el monitor web del navegador, protegiendo la privacidad
        // y sin exigir permisos nativos peligrosos en el sistema operativo Android.
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse("https://sismopa.pages.dev/#alertas"));
            intent.setPackage(getPackageName());
            startActivity(intent);
            finish();
        } catch (Exception e) {
            Toast.makeText(this, "Abre sismoPA para configurar tu distancia por GPS.", Toast.LENGTH_LONG).show();
        }
    }

    private void captureDeviceLocation() {
        // Obsoleto: gestionado dinámicamente desde el origen web de la TWA
    }



    private void onZoneSelectClicked() {
        final String[] zonas = {
            "Panamá (Centro)", "Panamá Oeste", "Chiriquí", "Bocas del Toro",
            "Coclé", "Colón", "Herrera", "Los Santos", "Veraguas", "Darién"
        };
        final double[][] coords = {
            {8.983, -79.520}, {8.880, -79.780}, {8.430, -82.430}, {9.333, -82.250},
            {8.500, -80.350}, {9.350, -79.900}, {7.960, -80.430}, {7.700, -80.300},
            {8.100, -80.980}, {8.350, -77.950}
        };

        new AlertDialog.Builder(this)
            .setTitle("Elige tu provincia o zona de referencia")
            .setItems(zonas, (dialog, which) -> {
                String selectedZone = zonas[which];
                double lat = coords[which][0];
                double lon = coords[which][1];
                FcmPreferences.setUserLocation(this, lat, lon, "ZONA", selectedZone);
                updateUi();
                Toast.makeText(this, "Zona fija establecida: " + selectedZone, Toast.LENGTH_SHORT).show();
            })
            .setNegativeButton("Cancelar", null)
            .show();
    }

    private void onClearLocationClicked() {
        FcmPreferences.clearUserLocation(this);
        updateUi();
        Toast.makeText(this, "Personalización por distancia desactivada", Toast.LENGTH_SHORT).show();
    }

}