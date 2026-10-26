# ==============================================================================
# Script seguro para firmar el Android App Bundle (AAB) Alpha 1.0.6 de sismoPA
# ==============================================================================
# - Version:          Alpha 1.0.6 (versionCode 7) - FCM Nativo Consolidado
# - Keystore Oficial: C:\Users\robin\.android\sismopa-upload-keystore.jks
# - Alias:            sismopa-upload
# - AAB Entrada:      android-twa\app\build\outputs\bundle\release\app-release.aab
# - AAB Salida:       android-twa\app\build\outputs\bundle\release\sismopa-v1.0.6-upload-signed.aab
#
# SEGURIDAD ESTRICTA:
# - Se ejecuta interactivamente en PowerShell / Windows Terminal por el usuario.
# - La contrasena se introduce con Read-Host -AsSecureString (oculta en pantalla).
# - NUNCA se escribe en disco, NUNCA se muestra en consola ni en logs.
# - PROTECCION TOTAL: No crea, no sobrescribe ni regenera keystores.
# - Limpieza garantizada de memoria inmediatamente al finalizar o en caso de error.
# ==============================================================================

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$jdkDir = "C:\Users\robin\.bubblewrap\jdk"
$keytool = Join-Path $jdkDir "bin\keytool.exe"
$jarsigner = Join-Path $jdkDir "bin\jarsigner.exe"

$androidHome = "C:\Users\robin\.android"
$keystorePath = Join-Path $androidHome "sismopa-upload-keystore.jks"
$alias = "sismopa-upload"

$projectRoot = Split-Path -Parent $PSScriptRoot
$bundleReleaseDir = Join-Path $projectRoot "android-twa\app\build\outputs\bundle\release"
$aabRelease = Join-Path $bundleReleaseDir "app-release.aab"
$aabSigned = Join-Path $bundleReleaseDir "sismopa-v1.0.6-upload-signed.aab"

Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "=== sismoPA: Firma Oficial AAB Alpha 1.0.6 (FCM Consolidado)   ===" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Verificaciones previas
if (-not (Test-Path $keytool)) {
    throw "No se encontro keytool en: $keytool"
}
if (-not (Test-Path $jarsigner)) {
    throw "No se encontro jarsigner en: $jarsigner"
}
if (-not (Test-Path $aabRelease)) {
    throw "No se encontro el AAB base en: $aabRelease. Ejecute primero gradlew bundleRelease."
}
if (-not (Test-Path $keystorePath)) {
    throw "ERROR CRITICO DE SEGURIDAD: No se encontro el Keystore oficial en: $keystorePath. Operacion abortada para proteger la configuracion."
}

# 2. Solicitud interactiva y segura de contrasena
Write-Host "[1/4] Keystore de Carga Oficial detectado:" -ForegroundColor Green
Write-Host "      Ruta:  $keystorePath"
Write-Host "      Alias: $alias"
Write-Host ""
Write-Host "Introduzca la contrasena maestra de la Clave de Carga (Kaspersky Password Manager):" -ForegroundColor Yellow
$securePassword = Read-Host -AsSecureString

if ($null -eq $securePassword -or $securePassword.Length -eq 0) {
    throw "Contrasena vacia. Operacion abortada."
}

$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
$plainPassword = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)

try {
    # 3. Validar contrasena y alias con keytool
    Write-Host ""
    Write-Host "[2/4] Verificando credenciales contra el Keystore..." -ForegroundColor Cyan

    $keytoolArgs = @(
        "-list",
        "-keystore", $keystorePath,
        "-alias", $alias,
        "-storepass", $plainPassword
    )

    $keytoolProcess = Start-Process -FilePath $keytool -ArgumentList $keytoolArgs -NoNewWindow -Wait -PassThru -RedirectStandardOutput "$env:TEMP\keytool_out.txt" -RedirectStandardError "$env:TEMP\keytool_err.txt"

    if ($keytoolProcess.ExitCode -ne 0) {
        $errText = Get-Content "$env:TEMP\keytool_err.txt" -Raw -ErrorAction SilentlyContinue
        Remove-Item "$env:TEMP\keytool_out.txt", "$env:TEMP\keytool_err.txt" -ErrorAction SilentlyContinue
        throw "Contrasena incorrecta o alias '$alias' no valido en el Keystore. Error: $errText"
    }
    Remove-Item "$env:TEMP\keytool_out.txt", "$env:TEMP\keytool_err.txt" -ErrorAction SilentlyContinue
    Write-Host "      Credenciales validadas exitosamente." -ForegroundColor Green

    # 4. Copiar AAB base al destino final y firmar con jarsigner
    Write-Host ""
    Write-Host "[3/4] Firmando AAB Alpha 1.0.6..." -ForegroundColor Cyan
    Copy-Item -Path $aabRelease -Destination $aabSigned -Force

    $jarsignerArgs = @(
        "-keystore", $keystorePath,
        "-storepass", $plainPassword,
        "-keypass", $plainPassword,
        "-sigalg", "SHA256withRSA",
        "-digestalg", "SHA-256",
        $aabSigned,
        $alias
    )

    $jarsignerProcess = Start-Process -FilePath $jarsigner -ArgumentList $jarsignerArgs -NoNewWindow -Wait -PassThru -RedirectStandardOutput "$env:TEMP\jarsigner_out.txt" -RedirectStandardError "$env:TEMP\jarsigner_err.txt"

    if ($jarsignerProcess.ExitCode -ne 0) {
        $errText = Get-Content "$env:TEMP\jarsigner_err.txt" -Raw -ErrorAction SilentlyContinue
        Remove-Item "$env:TEMP\jarsigner_out.txt", "$env:TEMP\jarsigner_err.txt" -ErrorAction SilentlyContinue
        throw "Fallo al firmar con jarsigner. Codigo: $($jarsignerProcess.ExitCode). Detalle: $errText"
    }
    Remove-Item "$env:TEMP\jarsigner_out.txt", "$env:TEMP\jarsigner_err.txt" -ErrorAction SilentlyContinue

    Write-Host "      AAB firmado satisfactoriamente." -ForegroundColor Green

    # 5. Verificacion de firma
    Write-Host ""
    Write-Host "[4/4] Verificando firma del AAB final..." -ForegroundColor Cyan

    $verifyArgs = @(
        "-verify",
        "-certs",
        $aabSigned
    )

    $verifyProcess = Start-Process -FilePath $jarsigner -ArgumentList $verifyArgs -NoNewWindow -Wait -PassThru -RedirectStandardOutput "$env:TEMP\verify_out.txt" -RedirectStandardError "$env:TEMP\verify_err.txt"
    $verifyOut = Get-Content "$env:TEMP\verify_out.txt" -Raw -ErrorAction SilentlyContinue
    Remove-Item "$env:TEMP\verify_out.txt", "$env:TEMP\verify_err.txt" -ErrorAction SilentlyContinue

    if ($verifyProcess.ExitCode -ne 0 -or $verifyOut -notmatch "jar verified") {
        throw "La verificacion del AAB firmado no supero la prueba de integridad."
    }

    $aabItem = Get-Item $aabSigned
    Write-Host "      Firma verificada: jar verified." -ForegroundColor Green
    Write-Host ""
    Write-Host "==================================================================" -ForegroundColor Green
    Write-Host "=== AAB Alpha 1.0.6 LISTO PARA GOOGLE PLAY                    ===" -ForegroundColor Green
    Write-Host "==================================================================" -ForegroundColor Green
    Write-Host "Archivo: $($aabItem.FullName)"
    Write-Host "Tamano:  $([Math]::Round($aabItem.Length / 1MB, 2)) MB ($($aabItem.Length) bytes)"
    Write-Host "Fecha:   $($aabItem.LastWriteTime)"
    Write-Host ""
    Write-Host "Siguiente paso: Ejecute node scripts/verify_upload_signed_v106_aab.js para validar certificados antes de subir a Google Play Console." -ForegroundColor Cyan

} finally {
    # 6. Limpieza garantizada de memoria
    if ($bstr -ne [IntPtr]::Zero) {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    $plainPassword = $null
    $securePassword = $null
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
}
