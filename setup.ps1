# Node.js is a prerequisite; this wrapper never installs it or changes execution policy.
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'Node.js 22+ is required. Install it, reopen the terminal, and rerun setup.'
    exit 1
}
& node (Join-Path $PSScriptRoot 'scripts/setup.mjs') @args
exit $LASTEXITCODE
