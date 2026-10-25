# ==============================================================================
# Script seguro para firmar el Android App Bundle (AAB) Alpha 1.0.2 de sismoPA
# ==============================================================================
# - Keystore Oficial: C:\Users\robin\.android\sismopa-upload-keystore.jks
# - Alias:            sismopa-upload
# - AAB Entrada:      android-twa\app\build\outputs\bundle\release\app-release.aab
# - AAB Salida:       android-twa\app\build\outputs\bundle\release\sismopa-v1.0.2-upload-signed.aab
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
$aabSigned = Join-Path $bundleReleaseDir "sismopa-v1.0.2-upload-signed.aab"

Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "=== sismoPA: Firma Oficial AAB Alpha 1.0.2 (Clave de Carga)   ===" -ForegroundColor Cyan
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
    throw "No se encontro el AAB base en: $aabRelease"
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

$secPass = Read-Host -Prompt "Contrasena del Keystore" -AsSecureString
$plainPassword = [System.Net.NetworkCredential]::new('', $secPass).Password

if ([string]::IsNullOrWhiteSpace($plainPassword)) {
    throw "La contrasena no puede estar vacia. Operacion cancelada."
}

# Configurar variable de entorno en memoria exclusiva del proceso
$env:SISMO_UPLOAD_PASS = $plainPassword

try {
    # 3. Validar apertura del Keystore y huella SHA-256
    Write-Host "`n[2/4] Validando apertura del Keystore y huella digital..." -ForegroundColor Cyan
    $certListOutput = & $keytool -list -v -keystore $keystorePath -alias $alias -storepass:env SISMO_UPLOAD_PASS
    if ($LASTEXITCODE -ne 0) {
        throw "Contrasena incorrecta o error al abrir el keystore."
    }

    $sha256Fingerprint = "NO_DETECTADA"
    foreach ($line in $certListOutput) {
        if ($line -match 'SHA256:\s*([A-F0-9:]+)') {
            $sha256Fingerprint = $matches[1].Trim()
            break
        }
    }

    $expectedSha256 = "D2:59:B7:64:52:58:C0:EB:78:7D:5C:F5:5B:05:E4:04:00:64:B7:78:5B:9A:ED:FE:E5:46:00:B6:DD:CC:A0:FE"
    Write-Host "      Huella SHA-256 del certificado: $sha256Fingerprint" -ForegroundColor Yellow
    if ($sha256Fingerprint -ne $expectedSha256) {
        throw "ALERTA DE SEGURIDAD: La huella SHA-256 no coincide con la registrada en Google Play ($expectedSha256)."
    }
    Write-Host "      Coincidencia exacta con Google Play Console (OK)" -ForegroundColor Green

    # 4. Copiar y firmar sismopa-v1.0.2-upload-signed.aab
    Write-Host "`n[3/4] Generando y firmando sismopa-v1.0.2-upload-signed.aab..." -ForegroundColor Cyan
    if (Test-Path $aabSigned) {
        Remove-Item $aabSigned -Force
    }
    Copy-Item $aabRelease $aabSigned -Force

    & $jarsigner -keystore $keystorePath `
        -storepass:env SISMO_UPLOAD_PASS `
        -keypass:env SISMO_UPLOAD_PASS `
        -sigalg SHA256withRSA `
        -digestalg SHA-256 `
        $aabSigned `
        $alias

    if ($LASTEXITCODE -ne 0) {
        throw "Error al firmar $aabSigned con jarsigner."
    }
    Write-Host "      AAB firmado exitosamente con SHA256withRSA." -ForegroundColor Green

    # 5. Verificacion criptografica con jarsigner
    Write-Host "`n[4/4] Verificando firma criptografica del AAB..." -ForegroundColor Cyan
    $verifyOutput = & $jarsigner -verify -verbose -certs $aabSigned
    $isVerified = $false
    foreach ($line in $verifyOutput) {
        if ($line -match 'jar verified\.') {
            $isVerified = $true
            break
        }
    }
    if (-not $isVerified) {
        throw "Fallo la verificacion criptografica de $aabSigned."
    }
    Write-Host "      Firma verificada: jar verified. (OK)" -ForegroundColor Green

    # Resumen final
    $aabItem = Get-Item $aabSigned
    $aabHash = (Get-FileHash -Path $aabSigned -Algorithm SHA256).Hash
    $sizeMb = [math]::Round($aabItem.Length / 1MB, 2)

    Write-Host "`n==================================================================" -ForegroundColor Green
    Write-Host "=== EXITO: AAB Alpha 1.0.2 FIRMADO PARA GOOGLE PLAY ===" -ForegroundColor Green
    Write-Host "==================================================================" -ForegroundColor Green
    Write-Host "Ruta del AAB firmado: $aabSigned"
    Write-Host "Tamano del archivo:   $($aabItem.Length) bytes ($sizeMb MB)"
    Write-Host "SHA-256 del binario:  $aabHash"
    Write-Host "Huella Certificado:   $sha256Fingerprint"
    Write-Host "Estado de firma:      jar verified (Valida)"
    Write-Host "Package ID:           pa.sismodata.app"
    Write-Host "Version:              1.0.2 (versionCode 3)"
    Write-Host "==================================================================" -ForegroundColor Green

} finally {
    # Borrado seguro inmediato de la contrasena de la memoria y variables de entorno
    $env:SISMO_UPLOAD_PASS = $null
    $plainPassword = $null
    $secPass = $null
    [System.GC]::Collect()
}
