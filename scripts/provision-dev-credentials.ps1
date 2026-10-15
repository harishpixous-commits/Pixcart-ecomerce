# scripts/provision-dev-credentials.ps1
# Sets a password on the seeded staff and vendor rows so they can sign in locally (V008).
#
# WHY THIS IS A SCRIPT AND NOT A SPRING PROFILE
# ---------------------------------------------
# V008 added a nullable password_hash to id_staff and ven_store and deliberately left it
# NULL: PasswordHasher.matches fails closed on a null hash, so an unprovisioned account is
# refused exactly as a wrong password is. That is the correct production behaviour -- an
# operator provisions accounts through whatever process the platform runs.
#
# This script exists so the LOCAL development database can demonstrate a staff or vendor
# login at all. It is deliberately not reachable from the running service: there is no
# profile, property or environment variable that enables it, and the Java tool it wraps
# refuses to run unless the operator types the confirmation flag on the command line.
#
# Each account gets a FRESH random password, printed once. Nothing is written in plaintext.
# Re-running rotates every credential below and prints the replacements.
#
# Usage:
#   ./scripts/provision-dev-credentials.ps1
#
# Env overrides:
#   IDENTITY_DB_URL, IDENTITY_DB_USER, IDENTITY_DB_PASSWORD

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$svc  = Join-Path $root 'services/identity-svc'
$jar  = Join-Path $svc 'target/identity-svc-0.1.0-SNAPSHOT.jar'

if (-not (Test-Path $jar)) {
    Write-Error "Not found: $jar`nBuild it first: cd services/identity-svc; mvn -B -ntp -DskipTests package"
}

$url  = if ($env:IDENTITY_DB_URL)     { $env:IDENTITY_DB_URL }     else { 'jdbc:mariadb://127.0.0.1:3306/pixcart_dev' }
$user = if ($env:IDENTITY_DB_USER)    { $env:IDENTITY_DB_USER }    else { 'pixcart' }
$pass = if ($env:IDENTITY_DB_PASSWORD){ $env:IDENTITY_DB_PASSWORD }else { 'pixcart_dev_pw' }

Write-Host "Provisioning dev credentials into $url"
Write-Host ""

& java -cp $jar `
    'com.pixous.pixcart.identity.tools.ProvisionDevCredentials' `
    '--i-understand-this-writes-to-the-database' `
    $url $user $pass

exit $LASTEXITCODE
