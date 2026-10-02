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

    Write-Host "Flash completed successfully on $boardPort." -ForegroundColor Green
}
catch {
    Write-Host "Flash failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
