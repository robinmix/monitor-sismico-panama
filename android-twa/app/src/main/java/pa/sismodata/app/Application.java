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

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

public class Application extends android.app.Application {

  @Override
  public void onCreate() {
      super.onCreate();
      
      // Inicializar canal de notificaciones nativas sismoPA
      SismoNotificationHelper.createNotificationChannel(this);

      // Inicializar FirebaseApp si está disponible la configuración
      try {
          FirebaseApp.initializeApp(this);
          // Control estricto de auto-inicialización basado exclusivamente en el consentimiento voluntario
          boolean optedIn = FcmPreferences.isOptedIn(this);
          FirebaseMessaging.getInstance().setAutoInitEnabled(optedIn);
      } catch (Exception ignored) {
          // Tolerancia ante entornos de prueba sin google-services
      }
  }
}
