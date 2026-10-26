const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');

test('Auditoría Integral de Identidad de Notificaciones Android TWA y Web Push', async (t) => {

  await t.test('1. twa-manifest.json: enableNotifications=true, monochromeIconUrl y metadatos TWA', () => {
    const twaManifestPath = path.join(ROOT_DIR, 'android-twa', 'twa-manifest.json');
    assert.ok(fs.existsSync(twaManifestPath), 'android-twa/twa-manifest.json debe existir');

    const manifest = JSON.parse(fs.readFileSync(twaManifestPath, 'utf8'));
    assert.equal(manifest.packageId, 'pa.sismodata.app', 'Package ID debe ser pa.sismodata.app');
    assert.equal(manifest.host, 'sismopa.pages.dev', 'Host debe ser sismopa.pages.dev');
    assert.equal(manifest.name, 'sismoPA', 'Nombre de la app debe ser sismoPA');
    assert.equal(manifest.launcherName, 'sismoPA', 'Launcher name debe ser sismoPA');
    assert.ok(['1.0.3', '1.0.4', '1.0.5', '1.0.6'].includes(manifest.appVersionName), 'appVersionName debe ser 1.0.3, 1.0.4 o 1.0.5');
    assert.ok(manifest.appVersionCode >= 4, 'appVersionCode debe ser >= 4 (superior a versión 3 de Google Play)');
    assert.equal(manifest.enableNotifications, true, 'enableNotifications DEBE ser true para permitir delegación');
    assert.equal(
      manifest.monochromeIconUrl,
      'https://sismopa.pages.dev/assets/icons/badge-96.png',
      'monochromeIconUrl debe apuntar a la URL pública del badge monocromático'
    );

    // Huellas digitales en twa-manifest
    const fps = manifest.fingerprints.map(f => f.value.toUpperCase());
    const GOOGLE_PLAY_APP_SIGNING = 'E6:73:81:9A:EB:11:75:10:76:99:E0:75:55:E7:31:58:39:2D:CA:C2:84:9B:79:61:DC:1C:89:DE:77:A3:E1:9D';
    const TEST_SIGNING = 'CC:39:25:F5:4F:1E:8B:B5:77:B9:F0:AD:3C:95:CE:28:10:44:06:D7:A8:7C:3D:1A:30:00:35:5C:7E:4A:24:DC';

    assert.ok(fps.includes(GOOGLE_PLAY_APP_SIGNING), 'twa-manifest debe contener la huella de Google Play App Signing');
    assert.ok(fps.includes(TEST_SIGNING), 'twa-manifest debe contener la huella de clave de pruebas');
  });

  await t.test('2. android-twa/app/build.gradle: enableNotifications=true y compatibilidad Android 13+', () => {
    const buildGradlePath = path.join(ROOT_DIR, 'android-twa', 'app', 'build.gradle');
    assert.ok(fs.existsSync(buildGradlePath), 'build.gradle debe existir');

    const content = fs.readFileSync(buildGradlePath, 'utf8');
    assert.match(
      content,
      /enableNotifications:\s*true/,
      'build.gradle twaManifest.enableNotifications debe ser true'
    );
    assert.match(
      content,
      /resValue\s+"bool",\s+"enableNotification",\s+twaManifest\.enableNotifications\.toString\(\)/,
      'enableNotification resource debe sincronizarse con twaManifest.enableNotifications'
    );
    assert.match(
      content,
      /targetSdkVersion\s+3[3-9]/,
      'targetSdkVersion debe ser 33 o superior (Android 13+)'
    );
    assert.match(
      content,
      /com\.google\.androidbrowserhelper:androidbrowserhelper/,
      'Debe incluir la librería com.google.androidbrowserhelper'
    );
  });

  await t.test('3. AndroidManifest.xml: POST_NOTIFICATIONS, DelegationService y SMALL_ICON', () => {
    const manifestPath = path.join(ROOT_DIR, 'android-twa', 'app', 'src', 'main', 'AndroidManifest.xml');
    assert.ok(fs.existsSync(manifestPath), 'AndroidManifest.xml debe existir');

    const manifestXml = fs.readFileSync(manifestPath, 'utf8');

    // Permiso para Android 13+
    assert.match(
      manifestXml,
      /<uses-permission\s+android:name="android\.permission\.POST_NOTIFICATIONS"\s*\/>/,
      'AndroidManifest debe declarar el permiso POST_NOTIFICATIONS para Android 13+'
    );

    // DelegationService configurado y exportado mediante @bool/enableNotification
    assert.match(
      manifestXml,
      /<service[\s\S]*?android:name="\.DelegationService"[\s\S]*?android:enabled="@bool\/enableNotification"[\s\S]*?android:exported="@bool\/enableNotification"[\s\S]*?>/,
      'DelegationService debe estar configurado con android:enabled y android:exported vinculados a @bool/enableNotification'
    );

    // Metadata SMALL_ICON dentro de DelegationService
    assert.match(
      manifestXml,
      /<meta-data[\s\S]*?android:name="android\.support\.customtabs\.trusted\.SMALL_ICON"[\s\S]*?android:resource="@drawable\/ic_notification_icon"[\s\S]*?\/>/,
      'DelegationService debe contener el meta-data SMALL_ICON apuntando a @drawable/ic_notification_icon'
    );

    // Intent filter TRUSTED_WEB_ACTIVITY_SERVICE
    assert.match(
      manifestXml,
      /<action\s+android:name="android\.support\.customtabs\.trusted\.TRUSTED_WEB_ACTIVITY_SERVICE"\s*\/>/,
      'DelegationService debe registrar la acción TRUSTED_WEB_ACTIVITY_SERVICE'
    );
  });

  await t.test('4. Recursos Drawables Monocromáticos: densidad y especificación Android', () => {
    const resDir = path.join(ROOT_DIR, 'android-twa', 'app', 'src', 'main', 'res');
    const densities = [
      { folder: 'drawable-mdpi', size: 24 },
      { folder: 'drawable-hdpi', size: 36 },
      { folder: 'drawable-xhdpi', size: 48 },
      { folder: 'drawable-xxhdpi', size: 72 },
      { folder: 'drawable-xxxhdpi', size: 96 }
    ];

    for (const d of densities) {
      const iconPath = path.join(resDir, d.folder, 'ic_notification_icon.png');
      assert.ok(fs.existsSync(iconPath), `Debe existir ${d.folder}/ic_notification_icon.png`);
      const stat = fs.statSync(iconPath);
      assert.ok(stat.size > 100, `El archivo ${d.folder}/ic_notification_icon.png debe contener datos válidos`);

      // Verificar cabecera PNG
      const buf = fs.readFileSync(iconPath);
      assert.equal(buf[0], 0x89, 'Cabecera PNG byte 0');
      assert.equal(buf[1], 0x50, 'Cabecera PNG byte 1 (P)');
      assert.equal(buf[2], 0x4E, 'Cabecera PNG byte 2 (N)');
      assert.equal(buf[3], 0x47, 'Cabecera PNG byte 3 (G)');

      // Leer ancho y alto del chunk IHDR (bytes 16-23)
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      assert.equal(width, d.size, `Ancho de ${d.folder} debe ser ${d.size}px`);
      assert.equal(height, d.size, `Alto de ${d.folder} debe ser ${d.size}px`);
    }
  });

  await t.test('5. Badges Web Push: existencia, pureza y preservación de iconos a color', () => {
    const assetsDir = path.join(ROOT_DIR, 'assets', 'icons');
    const badge96 = path.join(assetsDir, 'badge-96.png');
    const badge72 = path.join(assetsDir, 'badge-72.png');

    assert.ok(fs.existsSync(badge96), 'assets/icons/badge-96.png debe existir');
    assert.ok(fs.existsSync(badge72), 'assets/icons/badge-72.png debe existir');

    const b96Buf = fs.readFileSync(badge96);
    assert.equal(b96Buf.readUInt32BE(16), 96, 'badge-96 ancho');
    assert.equal(b96Buf.readUInt32BE(20), 96, 'badge-96 alto');

    // Preservación estricta de los iconos actuales a color
    const icon192 = path.join(assetsDir, 'icon-192.png');
    const icon512 = path.join(assetsDir, 'icon-512.png');
    const maskable512 = path.join(assetsDir, 'icon-maskable-512.png');

    assert.ok(fs.existsSync(icon192), 'icon-192.png debe preservarse');
    assert.ok(fs.existsSync(icon512), 'icon-512.png debe preservarse');
    assert.ok(fs.existsSync(maskable512), 'icon-maskable-512.png debe preservarse');

    assert.ok(fs.statSync(icon192).size > 10000, 'icon-192.png intacto');
    assert.ok(fs.statSync(icon512).size > 50000, 'icon-512.png intacto');
  });

  await t.test('6. manifest.webmanifest: declaración purpose=monochrome sin alterar iconos de lanzamiento', () => {
    const manifestPath = path.join(ROOT_DIR, 'manifest.webmanifest');
    assert.ok(fs.existsSync(manifestPath), 'manifest.webmanifest debe existir');

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.name, 'sismoPA');
    assert.equal(manifest.short_name, 'sismoPA');

    const monoIcon = manifest.icons.find(i => i.purpose === 'monochrome');
    assert.ok(monoIcon, 'Debe existir un icono con purpose=monochrome en manifest.webmanifest');
    assert.equal(monoIcon.src, 'assets/icons/badge-96.png');
    assert.equal(monoIcon.sizes, '96x96');

    // Confirmar que siguen existiendo iconos any y maskable
    const anyIcon = manifest.icons.find(i => i.purpose === 'any');
    const maskableIcon = manifest.icons.find(i => i.purpose === 'maskable');
    assert.ok(anyIcon, 'Icono purpose=any debe preservarse');
    assert.ok(maskableIcon, 'Icono purpose=maskable debe preservarse');
  });

  await t.test('7. sw.js: configuración de badge, icon, tag, renotify y notificationclick', () => {
    const swPath = path.join(ROOT_DIR, 'sw.js');
    assert.ok(fs.existsSync(swPath), 'sw.js debe existir');

    const swContent = fs.readFileSync(swPath, 'utf8');

    // Pre-cacheo de badge en STATIC_ASSETS
    assert.match(
      swContent,
      /STATIC_ASSETS\s*=\s*\[[\s\S]*?'\.\/assets\/icons\/badge-96\.png'[\s\S]*?\]/,
      'STATIC_ASSETS en sw.js debe pre-cachear badge-96.png'
    );

    // Bypass Network-Only para /.well-known/
    assert.match(
      swContent,
      /url\.pathname\.includes\('\/\.well-known\/'\)/,
      'Regla Network-Only en sw.js debe incluir /.well-known/ para assetlinks'
    );

    // Manejador del evento push
    assert.match(
      swContent,
      /badge:\s*'\.\/assets\/icons\/badge-96\.png'/,
      'sw.js debe usar badge-96.png monocromático para el badge'
    );
    assert.match(
      swContent,
      /icon:\s*'\.\/assets\/icons\/icon-192\.png'/,
      'sw.js debe conservar icon-192.png a color para el icono grande'
    );
    assert.match(
      swContent,
      /tag:\s*data\.tag/,
      'sw.js debe configurar tag para colapso de duplicados'
    );
    assert.match(
      swContent,
      /renotify:\s*true/,
      'sw.js debe activar renotify'
    );

    // Manejador del evento notificationclick
    assert.match(
      swContent,
      /event\.notification\.close\(\)/,
      'notificationclick debe cerrar la notificación'
    );
    assert.match(
      swContent,
      /clients\.matchAll/,
      'notificationclick debe consultar clientes activos'
    );
  });

  await t.test('8. Digital Asset Links: relación bidireccional y huellas criptográficas', () => {
    const assetlinksPath = path.join(ROOT_DIR, '.well-known', 'assetlinks.json');
    assert.ok(fs.existsSync(assetlinksPath), '.well-known/assetlinks.json debe existir');

    const assetlinks = JSON.parse(fs.readFileSync(assetlinksPath, 'utf8'));
    assert.equal(Array.isArray(assetlinks), true);
    assert.equal(assetlinks[0].relation[0], 'delegate_permission/common.handle_all_urls');
    assert.equal(assetlinks[0].target.namespace, 'android_app');
    assert.equal(assetlinks[0].target.package_name, 'pa.sismodata.app');

    const fingerprints = assetlinks[0].target.sha256_cert_fingerprints.map(fp => fp.toUpperCase());

    const GOOGLE_PLAY_APP_SIGNING = 'E6:73:81:9A:EB:11:75:10:76:99:E0:75:55:E7:31:58:39:2D:CA:C2:84:9B:79:61:DC:1C:89:DE:77:A3:E1:9D';
    const TEST_SIGNING = 'CC:39:25:F5:4F:1E:8B:B5:77:B9:F0:AD:3C:95:CE:28:10:44:06:D7:A8:7C:3D:1A:30:00:35:5C:7E:4A:24:DC';
    const UPLOAD_KEY = 'D2:59:B7:64:52:58:C0:EB:78:7D:5C:F5:5B:05:E4:04:00:64:B7:78:5B:9A:ED:FE:E5:46:00:B6:DD:CC:A0:FE';

    assert.ok(
      fingerprints.includes(GOOGLE_PLAY_APP_SIGNING),
      'assetlinks.json debe incluir la huella de Google Play App Signing (clave con la que Play entrega el APK a los usuarios)'
    );
    assert.ok(
      fingerprints.includes(TEST_SIGNING),
      'assetlinks.json debe incluir la huella de pruebas local'
    );
    assert.equal(
      fingerprints.includes(UPLOAD_KEY),
      false,
      'assetlinks.json NO debe incluir la clave de subida (Upload Key), ya que los usuarios finales nunca ejecutan APKs firmados con ella'
    );
  });

  await t.test('9. AndroidManifest.xml procesado por Gradle (Merged Manifest): versión 1.0.3, versionCode 4, POST_NOTIFICATIONS, DelegationService y SMALL_ICON', () => {
    const mergedManifestPath = path.join(
      ROOT_DIR,
      'android-twa',
      'app',
      'build',
      'intermediates',
      'bundle_manifest',
      'release',
      'processApplicationManifestReleaseForBundle',
      'AndroidManifest.xml'
    );
    assert.ok(fs.existsSync(mergedManifestPath), 'El AndroidManifest.xml fusionado por Gradle debe existir');

    const xml = fs.readFileSync(mergedManifestPath, 'utf8');

    // Versión final y package
    assert.match(xml, /package="pa\.sismodata\.app"/, 'Package ID en manifiesto final');
    assert.match(xml, /android:versionCode="(4|5|6|7)"/, 'versionCode >= 4 en manifiesto final');
    assert.match(xml, /android:versionName="1\.0\.(3|4|5|6)"/, 'versionName 1.0.x en manifiesto final');

    // Permiso POST_NOTIFICATIONS
    assert.match(xml, /<uses-permission\s+android:name="android\.permission\.POST_NOTIFICATIONS"\s*\/>/, 'Permiso POST_NOTIFICATIONS en manifiesto final');

    // DelegationService configurado con @bool/enableNotification
    assert.match(xml, /<service[\s\S]*?android:name="pa\.sismodata\.app\.DelegationService"[\s\S]*?android:enabled="@bool\/enableNotification"[\s\S]*?android:exported="@bool\/enableNotification"/, 'DelegationService activo en manifiesto final');

    // SMALL_ICON
    assert.match(xml, /<meta-data[\s\S]*?android:name="android\.support\.customtabs\.trusted\.SMALL_ICON"[\s\S]*?android:resource="@drawable\/ic_notification_icon"/, 'SMALL_ICON en manifiesto final');

    // Intent filter TRUSTED_WEB_ACTIVITY_SERVICE
    assert.match(xml, /<action\s+android:name="android\.support\.customtabs\.trusted\.TRUSTED_WEB_ACTIVITY_SERVICE"\s*\/>/, 'TRUSTED_WEB_ACTIVITY_SERVICE en manifiesto final');

    // Valor del recurso resValue enableNotification
    const gradleResValuesPath = path.join(ROOT_DIR, 'android-twa', 'app', 'build', 'generated', 'res', 'resValues', 'release', 'values', 'gradleResValues.xml');
    assert.ok(fs.existsSync(gradleResValuesPath), 'gradleResValues.xml debe existir');
    const resXml = fs.readFileSync(gradleResValuesPath, 'utf8');
    assert.match(resXml, /<bool name="enableNotification">true<\/bool>/, 'enableNotification debe resolver a true en tiempo de ejecución');
  });

  await t.test('10. Binario AAB empaquetado (app-release.aab): contiene drawables monocromáticos e integridad', () => {
    const aabPath = path.join(ROOT_DIR, 'android-twa', 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab');
    assert.ok(fs.existsSync(aabPath), 'app-release.aab debe existir');

    const stat = fs.statSync(aabPath);
    assert.ok(stat.size > 2000000, `Tamaño del AAB debe ser superior a 2MB (actual: ${stat.size} bytes)`);

    // Inspeccionar que contenga los drawables monocromáticos
    const { execSync } = require('child_process');
    const jarTool = path.join(process.env.USERPROFILE, '.bubblewrap', 'jdk', 'bin', 'jar.exe');
    if (fs.existsSync(jarTool)) {
      const list = execSync(`"${jarTool}" tf "${aabPath}"`).toString();
      assert.ok(list.includes('base/res/drawable-mdpi-v4/ic_notification_icon.png'), 'mdpi ic_notification_icon en AAB');
      assert.ok(list.includes('base/res/drawable-hdpi-v4/ic_notification_icon.png'), 'hdpi ic_notification_icon en AAB');
      assert.ok(list.includes('base/res/drawable-xhdpi-v4/ic_notification_icon.png'), 'xhdpi ic_notification_icon en AAB');
      assert.ok(list.includes('base/res/drawable-xxhdpi-v4/ic_notification_icon.png'), 'xxhdpi ic_notification_icon en AAB');
      assert.ok(list.includes('base/res/drawable-xxxhdpi-v4/ic_notification_icon.png'), 'xxxhdpi ic_notification_icon en AAB');
      assert.ok(list.includes('base/manifest/AndroidManifest.xml'), 'AndroidManifest en base module del AAB');
    }
  });
});
