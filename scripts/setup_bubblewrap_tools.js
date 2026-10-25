const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BUBBLEWRAP_DIR = path.resolve(process.env.USERPROFILE, '.bubblewrap');
const JDK_DIR = path.join(BUBBLEWRAP_DIR, 'jdk');
const ANDROID_SDK_DIR = path.join(BUBBLEWRAP_DIR, 'android_sdk');
const TEMP_DIR = path.join(BUBBLEWRAP_DIR, 'temp_downloads');

if (!fs.existsSync(BUBBLEWRAP_DIR)) fs.mkdirSync(BUBBLEWRAP_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

async function downloadFile(url, destPath) {
  console.log(`Descargando: ${url} ...`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Fallo descarga (${response.status}): ${url}`);
  const fileStream = fs.createWriteStream(destPath);
  const reader = response.body.getReader();
  let downloadedBytes = 0;
  const totalBytes = parseInt(response.headers.get('content-length') || '0', 10);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    fileStream.write(Buffer.from(value));
    downloadedBytes += value.length;
    if (totalBytes > 0 && downloadedBytes % (15 * 1024 * 1024) < value.length) {
      const pct = Math.round((downloadedBytes / totalBytes) * 100);
      console.log(`   ${pct}% (${Math.round(downloadedBytes / 1024 / 1024)} MB de ${Math.round(totalBytes / 1024 / 1024)} MB)`);
    }
  }
  await new Promise((resolve) => fileStream.end(resolve));
  console.log(`Descarga finalizada: ${destPath}`);
}

async function setup() {
  console.log('=== INSTALACIÓN AISLADA DE HERRAMIENTAS BUBBLEWRAP ===');

  // 1. JDK 17
  const javaExe = path.join(JDK_DIR, 'bin', 'java.exe');
  if (!fs.existsSync(javaExe)) {
    console.log('[1/4] Instalando Eclipse Temurin OpenJDK 17...');
    const jdkZip = path.join(TEMP_DIR, 'jdk17.zip');
    const jdkUrl = 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.12%2B7/OpenJDK17U-jdk_x64_windows_hotspot_17.0.12_7.zip';
    if (!fs.existsSync(jdkZip)) {
      await downloadFile(jdkUrl, jdkZip);
    }
    const extractTemp = path.join(TEMP_DIR, 'jdk_extracted');
    if (fs.existsSync(extractTemp)) fs.rmSync(extractTemp, { recursive: true, force: true });
    fs.mkdirSync(extractTemp, { recursive: true });
    
    console.log('Extrayendo JDK 17...');
    execSync(`tar -xf "${jdkZip}" -C "${extractTemp}"`);
    
    const entries = fs.readdirSync(extractTemp);
    const innerDir = path.join(extractTemp, entries[0]);
    if (fs.existsSync(JDK_DIR)) fs.rmSync(JDK_DIR, { recursive: true, force: true });
    fs.renameSync(innerDir, JDK_DIR);
    console.log('JDK 17 instalado exitosamente en:', JDK_DIR);
  } else {
    console.log('[1/4] JDK 17 ya se encuentra instalado en:', JDK_DIR);
  }

  // Verificar versión de Java
  const javaVersionOutput = execSync(`"${javaExe}" -version 2>&1`).toString();
  console.log('Java activo:\n' + javaVersionOutput.trim());

  // 2. Android Command-line Tools
  const cmdlineToolsDir = path.join(ANDROID_SDK_DIR, 'cmdline-tools', 'latest');
  const sdkManagerBat = path.join(cmdlineToolsDir, 'bin', 'sdkmanager.bat');
  if (!fs.existsSync(sdkManagerBat)) {
    console.log('[2/4] Instalando Android Command-line Tools...');
    const sdkZip = path.join(TEMP_DIR, 'cmdline-tools.zip');
    const sdkUrl = 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip';
    if (!fs.existsSync(sdkZip)) {
      await downloadFile(sdkUrl, sdkZip);
    }
    const extractSdkTemp = path.join(TEMP_DIR, 'sdk_extracted');
    if (fs.existsSync(extractSdkTemp)) fs.rmSync(extractSdkTemp, { recursive: true, force: true });
    fs.mkdirSync(extractSdkTemp, { recursive: true });

    console.log('Extrayendo Android Command-line Tools...');
    execSync(`tar -xf "${sdkZip}" -C "${extractSdkTemp}"`);

    fs.mkdirSync(path.join(ANDROID_SDK_DIR, 'cmdline-tools'), { recursive: true });
    if (fs.existsSync(cmdlineToolsDir)) fs.rmSync(cmdlineToolsDir, { recursive: true, force: true });
    fs.renameSync(path.join(extractSdkTemp, 'cmdline-tools'), cmdlineToolsDir);
    console.log('Android Command-line Tools instalado en:', cmdlineToolsDir);
  } else {
    console.log('[2/4] Android Command-line Tools ya presente en:', cmdlineToolsDir);
  }

  // 3. Guardar configuración de Bubblewrap
  console.log('[3/4] Configurando config.json de Bubblewrap...');
  const config = {
    jdkPath: JDK_DIR,
    androidSdkPath: ANDROID_SDK_DIR
  };
  fs.writeFileSync(path.join(BUBBLEWRAP_DIR, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  console.log('config.json actualizado:', JSON.stringify(config));

  // 4. Aceptar licencias e instalar componentes de Android SDK
  console.log('[4/4] Instalando plataformas y herramientas Android SDK necesarias...');
  const env = {
    ...process.env,
    JAVA_HOME: JDK_DIR,
    ANDROID_HOME: ANDROID_SDK_DIR,
    ANDROID_SDK_ROOT: ANDROID_SDK_DIR,
    PATH: `${path.join(JDK_DIR, 'bin')};${path.join(cmdlineToolsDir, 'bin')};${process.env.PATH}`
  };

  // Aceptar licencias automáticamente
  try {
    console.log('Aceptando licencias de Android SDK...');
    execSync(`cmd.exe /c "echo y| call \"${sdkManagerBat}\" --licenses"`, { env, stdio: 'ignore' });
  } catch (e) {
    // Si ya fueron aceptadas o devuelve código no cero, continuar
  }

  console.log('Instalando platform-tools, platforms;android-34, platforms;android-35 y build-tools;34.0.0...');
  execSync(`cmd.exe /c "call \"${sdkManagerBat}\" \"platform-tools\" \"platforms;android-34\" \"platforms;android-35\" \"build-tools;34.0.0\""`, { env, stdio: 'inherit' });

  // Intentar instalar plataforma 36 si está disponible
  try {
    console.log('Consultando disponibilidad de platforms;android-36...');
    execSync(`cmd.exe /c "call \"${sdkManagerBat}\" \"platforms;android-36\""`, { env, stdio: 'inherit' });
  } catch (e) {
    console.log('Nota: platforms;android-36 no está en el canal estable aún o requiere preview SDK.');
  }

  // Limpiar descargas temporales para no ocupar espacio en disco
  if (fs.existsSync(TEMP_DIR)) {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }

  console.log('=== CONFIGURACIÓN DE HERRAMIENTAS COMPLETADA CON ÉXITO ===');
}

setup().catch(err => {
  console.error('Error durante la instalación:', err);
  process.exit(1);
});
