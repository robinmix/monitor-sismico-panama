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
 */
public class SismoNotificationSettingsActivity extends Activity {
    private static final String TAG = "SismoSettingsActivity";
    private static final int RC_PERMISSION = 3001;

    private TextView mStatusBadge;
    private TextView mStatusDesc;
    private TextView mErrorDesc;
    private Button mBtnAction;
    private TextView mTokenView;
    private Button mBtnTest;
    private Button mBtnCopyToken;
    private Button mBtnDismiss;

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
        subtitle.setText("Notificaciones oficiales instantáneas para Panamá");
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

        // Descripción de estado
        mStatusDesc = new TextView(this);
        mStatusDesc.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        mStatusDesc.setTextColor(Color.parseColor("#CFD8DC"));
        mStatusDesc.setLineSpacing(dp(2), 1.1f);
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

        // Tarjeta de Diagnóstico y Pruebas (Desarrollo)
        LinearLayout diagCard = new LinearLayout(this);
        diagCard.setOrientation(LinearLayout.VERTICAL);
        diagCard.setPadding(dp(16), dp(16), dp(16), dp(16));
        GradientDrawable diagBg = new GradientDrawable();
        diagBg.setColor(Color.parseColor("#0D111A"));
        diagBg.setCornerRadius(dp(12));
        diagBg.setStroke(dp(1), Color.parseColor("#1B2232"));
        diagCard.setBackground(diagBg);

        LinearLayout.LayoutParams diagParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        diagParams.topMargin = dp(16);

        TextView diagTitle = new TextView(this);
        diagTitle.setText("Herramientas de Desarrollo y Prueba");
        diagTitle.setTextColor(Color.parseColor("#90CAF9"));
        diagTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        diagTitle.setTypeface(Typeface.DEFAULT_BOLD);
        diagCard.addView(diagTitle);

        TextView diagTopic = new TextView(this);
        diagTopic.setText("Topic oficial: sismos_panama");
        diagTopic.setTextColor(Color.parseColor("#78909C"));
        diagTopic.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        diagTopic.setPadding(0, dp(4), 0, dp(8));
        diagCard.addView(diagTopic);

        mTokenView = new TextView(this);
        mTokenView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        mTokenView.setTextColor(Color.parseColor("#B0BEC5"));
        mTokenView.setTypeface(Typeface.MONOSPACE);
        mTokenView.setPadding(0, 0, 0, dp(8));
        diagCard.addView(mTokenView);

        LinearLayout diagButtons = new LinearLayout(this);
        diagButtons.setOrientation(LinearLayout.HORIZONTAL);

        mBtnTest = new Button(this);
        mBtnTest.setText("Probar Notificación");
        mBtnTest.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        LinearLayout.LayoutParams testParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        testParams.rightMargin = dp(6);
        diagButtons.addView(mBtnTest, testParams);

        mBtnCopyToken = new Button(this);
        mBtnCopyToken.setText("Copiar Token");
        mBtnCopyToken.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        LinearLayout.LayoutParams copyParams = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        copyParams.leftMargin = dp(6);
        diagButtons.addView(mBtnCopyToken, copyParams);

        diagCard.addView(diagButtons);
        layout.addView(diagCard, diagParams);

        // Botón volver / cerrar
        mBtnDismiss = new Button(this);
        mBtnDismiss.setText("Volver al Monitor");
        mBtnDismiss.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        mBtnDismiss.setTextColor(Color.parseColor("#B0BEC5"));
        mBtnDismiss.setBackgroundColor(Color.TRANSPARENT);
        LinearLayout.LayoutParams dismissParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        dismissParams.topMargin = dp(16);
        dismissParams.bottomMargin = dp(16);
        layout.addView(mBtnDismiss, dismissParams);

        scrollView.addView(layout);

        // Eventos
        mBtnAction.setOnClickListener(v -> onActionClicked());
        mBtnTest.setOnClickListener(v -> onTestNotificationClicked());
        mBtnCopyToken.setOnClickListener(v -> onCopyTokenClicked());
        mBtnDismiss.setOnClickListener(v -> finish());

        return scrollView;
    }

    private void updateUi() {
        FcmPreferences.State state = FcmPreferences.getState(this);
        String token = FcmPreferences.getToken(this);
        boolean isTopic = FcmPreferences.isTopicSubscribed(this);

        // Actualizar visualización del token
        if (token != null && !token.isEmpty()) {
            String masked = token.length() > 24 ? token.substring(0, 10) + "..." + token.substring(token.length() - 10) : token;
            mTokenView.setText("Token FCM: " + masked);
            mBtnCopyToken.setEnabled(true);
        } else {
            mTokenView.setText("Token FCM: No obtenido aún");
            mBtnCopyToken.setEnabled(false);
        }

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
                    mStatusDesc.setText("Confirmando suscripción con los servidores oficiales de Firebase...");
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
                mStatusDesc.setText("Tu teléfono está suscrito al topic oficial sismos_panama. Las alertas se emitirán como sismoPA con icono nativo y alta prioridad.");
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
                mStatusDesc.setText("Conectando con los servidores sísmicos y verificando suscripción...");
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
                    mStatusDesc.setText("Ocurrió un inconveniente al conectar con Firebase. Puedes intentar nuevamente.");
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
                mStatusDesc.setText("Cancelando suscripción en servidores sísmicos...");
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
                mStatusDesc.setText("Activa las alertas oficiales para recibir avisos inmediatos cuando ocurra un evento sísmico en Panamá reportado por el IGC-UP.");
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

                            // 2. Obtener token del dispositivo para diagnósticos y pruebas técnicas directas
                            FirebaseMessaging.getInstance().getToken()
                                    .addOnCompleteListener(this, tokenTask -> {
                                        if (tokenTask.isSuccessful() && tokenTask.getResult() != null) {
                                            String token = tokenTask.getResult();
                                            Log.i(TAG, "Token FCM obtenido exitosamente para diagnósticos locales");
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
                Toast.makeText(this, "Token FCM copiado al portapapeles", Toast.LENGTH_SHORT).show();
            }
        } else {
            Toast.makeText(this, "No hay token disponible todavía. Activa las alertas primero.", Toast.LENGTH_SHORT).show();
        }
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics());
    }
}
