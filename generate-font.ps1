[CmdletBinding()]
param(
    [string]$FontPath,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$GeneratorPath = Join-Path $PSScriptRoot "tools\generate_font.py"
$OutputPath = Join-Path $PSScriptRoot "client\sarasa_fixed_sc.h"

function Find-Python {
    foreach ($name in @("python", "python3")) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command) {
            return $command.Source
        }
    }

    throw "Python 3 was not found. Install Python before regenerating the font."
}

function Resolve-SarasaFont {
    if ($FontPath) {
        if (-not (Test-Path -LiteralPath $FontPath -PathType Leaf)) {
            throw "Font file was not found: $FontPath"
        }
        return (Resolve-Path -LiteralPath $FontPath).Path
    }

    $knownPaths = @(
        (Join-Path $env:WINDIR "Fonts\sarasa-fixed-sc-regular.ttf"),
        (Join-Path $env:LOCALAPPDATA "Microsoft\Windows\Fonts\sarasa-fixed-sc-regular.ttf")
    )

    foreach ($path in $knownPaths) {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            return $path
        }
    }

    foreach ($registryPath in @(
        "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts",
        "HKCU:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"
    )) {
        $entry = Get-ItemProperty $registryPath -ErrorAction SilentlyContinue
        $fileName = $entry."Sarasa Fixed SC (TrueType)"
        if (-not $fileName) {
            continue
        }

        $candidates = @(
            $fileName,
            (Join-Path $env:WINDIR "Fonts\$fileName"),
            (Join-Path $env:LOCALAPPDATA "Microsoft\Windows\Fonts\$fileName")
        )
        foreach ($candidate in $candidates) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                return (Resolve-Path -LiteralPath $candidate).Path
            }
        }
    }

    throw "Sarasa Fixed SC Regular was not found. Use -FontPath to provide its TTF file."
}

try {
    $python = Find-Python
    $font = Resolve-SarasaFont
    $semiboldFont = $font -replace "-regular\.ttf$", "-semibold.ttf"
    if (-not (Test-Path -LiteralPath $semiboldFont -PathType Leaf)) {
        throw "Sarasa Fixed SC Semibold was not found next to the regular font: $semiboldFont"
    }

    & $python -c "import PIL" 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw "Python package Pillow is required. Install it with: python -m pip install Pillow"
    }

    $semiboldFontFile = Get-Item -LiteralPath $semiboldFont
    $generatorFile = Get-Item -LiteralPath $GeneratorPath
    $outputFile = Get-Item -LiteralPath $OutputPath -ErrorAction SilentlyContinue
    $isCurrent = $outputFile `
        -and $outputFile.LastWriteTimeUtc -ge $semiboldFontFile.LastWriteTimeUtc `
        -and $outputFile.LastWriteTimeUtc -ge $generatorFile.LastWriteTimeUtc

    if ($isCurrent -and -not $Force) {
        Write-Host "Sarasa ASCII font is up to date." -ForegroundColor DarkGray
        exit 0
    }

    Write-Host "Generating Sarasa Fixed SC ASCII fonts..." -ForegroundColor Cyan
    & $python $GeneratorPath `
        --font $semiboldFont `
        --output $OutputPath `
        --sizes 16 24 `
        --threshold 128
    if ($LASTEXITCODE -ne 0) {
        throw "Font generation failed with exit code $LASTEXITCODE."
    }
}
catch {
    Write-Host "Font generation failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
