# ==============================================================================
# Script seguro para firmar el Android App Bundle (AAB) Alpha 1.0.11 de sismoPA
# ==============================================================================
# - Version:          Alpha 1.0.11 (versionCode 12) - GPS Compacto & Delegacion TWA
# - Keystore Oficial: C:\Users\robin\.android\sismopa-upload-keystore.jks
# - Alias:            sismopa-upload
# - SHA-256 Oficial:  CC:39:25:F5:4F:1E:8B:B5:77:B9:F0:AD:3C:95:CE:28:10:44:06:D7:A8:7C:3D:1A:30:00:35:5C:7E:4A:24:DC
# - AAB Entrada:      android-twa\app\build\outputs\bundle\release\app-release.aab
# - AAB Salida:       android-twa\app\build\outputs\bundle\release\sismopa-v1.0.11-upload-signed.aab
#
# SEGURIDAD ESTRICTA:
# - Se ejecuta interactivamente en PowerShell / Windows Terminal por el usuario.
# - La contrasena se introduce con Read-Host -AsSecureString (oculta en pantalla).
# - NUNCA se escribe en disco, NUNCA se muestra en consola ni en logs.
# - PROTECCION TOTAL: Reutiliza exclusivamente el Keystore oficial registrado.
#   NO crea, NO sobrescribe ni regenera claves.
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
$expectedSha256 = "CC:39:25:F5:4F:1E:8B:B5:77:B9:F0:AD:3C:95:CE:28:10:44:06:D7:A8:7C:3D:1A:30:00:35:5C:7E:4A:24:DC"

$projectRoot = Split-Path -Parent $PSScriptRoot
$bundleReleaseDir = Join-Path $projectRoot "android-twa\app\build\outputs\bundle\release"
$aabRelease = Join-Path $bundleReleaseDir "app-release.aab"
$aabSigned = Join-Path $bundleReleaseDir "sismopa-v1.0.11-upload-signed.aab"

Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "=== sismoPA: Firma Oficial AAB Alpha 1.0.11 (v12 - Google Play)===" -ForegroundColor Cyan
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
    # 3. Validar contrasena y certificado SHA-256 con keytool
    Write-Host ""
    Write-Host "[2/4] Verificando credenciales y huella SHA-256 contra el Keystore..." -ForegroundColor Cyan

    $keytoolArgs = @(
        "-list",
        "-v",
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

    $certDetails = Get-Content "$env:TEMP\keytool_out.txt" -Raw -ErrorAction SilentlyContinue
    Remove-Item "$env:TEMP\keytool_out.txt", "$env:TEMP\keytool_err.txt" -ErrorAction SilentlyContinue

    if ($certDetails -notmatch "SHA256:\s*([A-Fa-f0-9:]+)") {
        throw "No se pudo extraer la huella SHA-256 del certificado del keystore."
    }
    $actualSha256 = $Matches[1].Trim().ToUpper()

    Write-Host "      Huella SHA-256 detectada: $actualSha256" -ForegroundColor Cyan
    Write-Host "      Huella SHA-256 esperada:  $expectedSha256" -ForegroundColor Cyan

    if ($actualSha256 -ne $expectedSha256.ToUpper()) {
        throw "ERROR CRITICO: La huella digital del Keystore no coincide con la Clave de Carga registrada en Google Play Console."
    }

    Write-Host "      Huella digital CONFIRMADA: 100% coincidente con Google Play." -ForegroundColor Green

    # 4. Copiar AAB base al destino final y firmar con jarsigner
    Write-Host ""
    Write-Host "[3/4] Firmando AAB Alpha 1.0.11..." -ForegroundColor Cyan
    Copy-Item -Path $aabRelease -Destination $aabSigned -Force

    $jarsignerArgs = @(
        "-keystore", $keystorePath,
        "-storepass", $plainPassword,
        "-sigalg", "SHA256withRSA",
        "-digestalg", "SHA-256",
        $aabSigned,
        $alias
    )

    $jarsignerProcess = Start-Process -FilePath $jarsigner -ArgumentList $jarsignerArgs -NoNewWindow -Wait -PassThru -RedirectStandardOutput "$env:TEMP\jarsigner_out.txt" -RedirectStandardError "$env:TEMP\jarsigner_err.txt"

    if ($jarsignerProcess.ExitCode -ne 0) {
        $errText = Get-Content "$env:TEMP\jarsigner_err.txt" -Raw -ErrorAction SilentlyContinue
        Remove-Item "$env:TEMP\jarsigner_out.txt", "$env:TEMP\jarsigner_err.txt" -ErrorAction SilentlyContinue
        throw "Error al firmar con jarsigner: $errText"
    }
    Remove-Item "$env:TEMP\jarsigner_out.txt", "$env:TEMP\jarsigner_err.txt" -ErrorAction SilentlyContinue
    Write-Host "      AAB firmado satisfactoriamente con la Clave de Carga Oficial." -ForegroundColor Green

    # 5. Verificacion criptografica final
    Write-Host ""
    Write-Host "[4/4] Verificando firma digital del AAB..." -ForegroundColor Cyan

    $verifyArgs = @(
        "-verify",
        "-verbose",
        "-certs",
        $aabSigned
    )

    $verifyProcess = Start-Process -FilePath $jarsigner -ArgumentList $verifyArgs -NoNewWindow -Wait -PassThru -RedirectStandardOutput "$env:TEMP\verify_out.txt" -RedirectStandardError "$env:TEMP\verify_err.txt"
    $verifyOutput = Get-Content "$env:TEMP\verify_out.txt" -Raw -ErrorAction SilentlyContinue
    Remove-Item "$env:TEMP\verify_out.txt", "$env:TEMP\verify_err.txt" -ErrorAction SilentlyContinue

    if ($verifyOutput -notmatch "jar verified") {
        throw "La verificacion de firma fallo: el AAB no contiene una firma valida."
    }

    Write-Host "      Firma verificada: jar verified (OK)" -ForegroundColor Green

    $fileSize = (Get-Item $aabSigned).Length / 1MB
    Write-Host ""
    Write-Host "==================================================================" -ForegroundColor Green
    Write-Host "=== AAB Alpha 1.0.11 Firmado y Listo para Google Play Console  ===" -ForegroundColor Green
    Write-Host "==================================================================" -ForegroundColor Green
    Write-Host "Ruta:   $aabSigned" -ForegroundColor Yellow
    Write-Host "Tamano: $([math]::Round($fileSize, 2)) MB" -ForegroundColor Yellow
    Write-Host ""
}
finally {
    # 6. Limpieza garantizada de memoria
    if ($bstr -ne [IntPtr]::Zero) {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    $plainPassword = $null
    $securePassword = $null
    [System.GC]::Collect()
}
