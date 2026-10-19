param(
    [Parameter(Mandatory=$true)][ValidateSet('windows-msvc-debug','windows-msvc-release')][string]$Preset
)
$ErrorActionPreference = 'Stop'

# Only used later inside the task's worktree. This script never fetches or pushes.
if (-not (Test-Path -LiteralPath 'CMakePresets.json')) { throw 'Run from the alpha worktree root.' }
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
& cmake --build --preset $Preset --parallel 4
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& ctest --test-dir "builds/$Preset" --output-on-failure
exit $LASTEXITCODE
