package pa.sismodata.app;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

/**
 * Actividad translúcida oficial para la gestión explícita del permiso Android de ubicación
 * iniciada desde la chincheta web ("Mi distancia al sismo").
 *
 * Se ejecuta en primer plano como respuesta directa al gesto del usuario en la TWA,
 * cumpliendo 100% con las restricciones BAL (Background Activity Launch) de Android 10-15+
 * y garantizando que el cuadro de diálogo oficial del sistema se presente sin depender
 * de la configuración nativa de notificaciones (campanita).
 */
public class LocationPermissionActivity extends Activity {
    private static final String TAG = "SismoLocationPermAct";
    private static final int RC_LOCATION_PERM = 6001;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Si ya está concedido a nivel de sistema, cerrar de inmediato
        if (hasLocationPermission()) {
            Log.i(TAG, "Permiso de ubicación ya concedido previamente. Cerrando puente translúcido.");
            finish();
            return;
        }

        // Solicitar permisos de ubicación estándar (Precisa y Aproximada)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Log.i(TAG, "Solicitando permiso de ubicación en primer plano por interacción de chincheta...");
            ActivityCompat.requestPermissions(
                    this,
                    new String[]{
                            Manifest.permission.ACCESS_FINE_LOCATION,
                            Manifest.permission.ACCESS_COARSE_LOCATION
                    },
                    RC_LOCATION_PERM
            );
        } else {
            finish();
        }
    }

    private boolean hasLocationPermission() {
        boolean fine = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean coarse = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        return fine || coarse;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == RC_LOCATION_PERM) {
            boolean granted = false;
            for (int res : grantResults) {
                if (res == PackageManager.PERMISSION_GRANTED) {
                    granted = true;
                    break;
                }
            }
            Log.i(TAG, "Resultado de permiso de ubicación recibido: " + (granted ? "CONCEDIDO" : "DENEGADO"));
        }
        // Cerrar de inmediato la actividad translúcida para devolver el foco de forma imperceptible a la TWA
        finish();
    }
}
