param(
    [Parameter(Mandatory=$true)][ValidateSet('windows-msvc-debug','windows-msvc-release')][string]$Preset,
    [string]$Target,
    [string]$TestRegex
)
$ErrorActionPreference = 'Stop'

# Target and TestRegex select an incremental worker check; omission selects supervisor full verification.
if ([bool]$Target -ne [bool]$TestRegex) { throw 'Incremental checks require both Target and TestRegex.' }
if (-not (Test-Path -LiteralPath 'CMakePresets.json')) { throw 'Run from the alpha workspace root.' }
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Use Developer PowerShell or install Visual Studio C++ tools.' }
    $vsInstall = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $vsInstall) { throw 'No Visual Studio C++ installation found.' }
    $devShell = Join-Path $vsInstall 'Common7/Tools/Launch-VsDevShell.ps1'
    & $devShell -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
}
foreach ($required in @('VCPKG_ROOT','VULKAN_SDK')) {
    if (-not [Environment]::GetEnvironmentVariable($required)) { throw "Missing environment variable: $required" }
}
& cmake --preset $Preset
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$buildArgs = @('--build', '--preset', $Preset, '--parallel', '4')
if ($Target) { $buildArgs += @('--target', $Target) }
& cmake @buildArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$testArgs = @('--test-dir', "builds/$Preset", '--output-on-failure', '--no-tests=error')
if ($TestRegex) { $testArgs += @('-R', $TestRegex) }
& ctest @testArgs
exit $LASTEXITCODE
