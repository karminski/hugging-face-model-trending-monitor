[CmdletBinding()]
param(
    [string]$Port
)

$ErrorActionPreference = "Stop"

$Fqbn = "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,USBMode=hwcdc,CDCOnBoot=cdc"
$SketchDirectory = Join-Path $PSScriptRoot "client"

function Find-ArduinoCli {
    $command = Get-Command "arduino-cli" -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $knownPaths = @(
        (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\arduino-cli.exe"),
        (Join-Path $env:ProgramFiles "Arduino CLI\arduino-cli.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Arduino CLI\arduino-cli.exe")
    )

    foreach ($path in $knownPaths) {
        if ($path -and (Test-Path $path)) {
            return $path
        }
    }

    throw "Arduino CLI was not found. Install it with: winget install --id ArduinoSA.CLI --exact"
}

function Invoke-ArduinoCli {
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments
    )

    & $script:ArduinoCli @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "arduino-cli failed with exit code $LASTEXITCODE."
    }
}

function Install-Dependencies {
    $coreList = (& $script:ArduinoCli core list 2>&1) -join "`n"
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to read the installed Arduino cores."
    }

    if ($coreList -notmatch "(?m)^esp32:esp32\s+3\.3\.0\b") {
        Write-Host "Installing ESP32 Arduino core 3.3.0..." -ForegroundColor Cyan
        Invoke-ArduinoCli -Arguments @("core", "update-index")
        Invoke-ArduinoCli -Arguments @("core", "install", "esp32:esp32@3.3.0")
    }

    $libraryList = (& $script:ArduinoCli lib list 2>&1) -join "`n"
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to read the installed Arduino libraries."
    }

    if ($libraryList -notmatch "(?m)^U8g2\s+2\.36\.19\b") {
        Write-Host "Installing U8g2 2.36.19..." -ForegroundColor Cyan
        Invoke-ArduinoCli -Arguments @("lib", "update-index")
        Invoke-ArduinoCli -Arguments @("lib", "install", "U8g2@2.36.19")
    }
}

function Update-Font {
    $fontScript = Join-Path $PSScriptRoot "generate-font.ps1"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $fontScript
    if ($LASTEXITCODE -ne 0) {
        throw "Font generation failed with exit code $LASTEXITCODE."
    }
}

function Find-Esptool {
    $toolRoot = Join-Path $env:LOCALAPPDATA "Arduino15\packages\esp32\tools\esptool_py"
    $preferred = Join-Path $toolRoot "5.0.0\esptool.exe"
    if (Test-Path -LiteralPath $preferred) {
        return $preferred
    }

    if (Test-Path -LiteralPath $toolRoot) {
        $found = Get-ChildItem -LiteralPath $toolRoot -Filter "esptool.exe" -Recurse -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending |
            Select-Object -First 1
        if ($found) {
            return $found.FullName
        }
    }

    throw "esptool was not found. Install ESP32 Arduino core 3.3.0 and try again."
}

function Invoke-HardReset {
    param(
        [Parameter(Mandatory)]
        [string]$BoardPort
    )

    $esptool = Find-Esptool
    Write-Host "Hard resetting $BoardPort..." -ForegroundColor Cyan
    & $esptool --chip esp32s3 --port $BoardPort --before default-reset --after hard-reset run
    if ($LASTEXITCODE -ne 0) {
        throw "Hard reset failed with exit code $LASTEXITCODE."
    }
}

function Find-BoardPort {
    if ($Port) {
        return $Port
    }

    $ports = @(
        Get-CimInstance Win32_SerialPort |
            Where-Object { $_.PNPDeviceID -match "^USB\\VID_303A&PID_1001" } |
            Select-Object -ExpandProperty DeviceID
    )

    if ($ports.Count -eq 0) {
        throw "ESP32-S3 was not found. Connect the board by USB and try again."
    }

    if ($ports.Count -gt 1) {
        throw "Multiple ESP32-S3 ports were found: $($ports -join ', '). Run .\flash.ps1 -Port COMx."
    }

    return $ports[0]
}

try {
    $configPath = Join-Path $SketchDirectory "config.h"
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw "Missing client/config.h. Copy client/config.example.h to client/config.h, then set WIFI_SSID, WIFI_PASSWORD, and TRENDING_API_URL."
    }

    $script:ArduinoCli = Find-ArduinoCli
    Install-Dependencies
    Update-Font
    $boardPort = Find-BoardPort

    Write-Host "Compiling firmware..." -ForegroundColor Cyan
    Invoke-ArduinoCli -Arguments @(
        "compile",
        "--fqbn", $Fqbn,
        $SketchDirectory
    )

    Write-Host "Uploading to $boardPort..." -ForegroundColor Cyan
    Invoke-ArduinoCli -Arguments @(
        "upload",
        "--port", $boardPort,
        "--fqbn", $Fqbn,
        $SketchDirectory
    )

    Start-Sleep -Seconds 2
    $resetPort = Find-BoardPort
    Invoke-HardReset -BoardPort $resetPort

    Write-Host "Flash completed successfully on $resetPort." -ForegroundColor Green
}
catch {
    Write-Host "Flash failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
