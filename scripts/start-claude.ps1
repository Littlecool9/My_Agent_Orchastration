param([Parameter(Mandatory=$true)][string]$ProjectPath)
$ErrorActionPreference = 'Stop'
$workflowRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $workflowRoot 'dist/src/cli.js'))) { throw 'Run npm run build in the workflow folder first.' }
if (-not (Test-Path -LiteralPath $ProjectPath -PathType Container)) { throw 'ProjectPath must exist.' }
$pluginPath = Join-Path $workflowRoot 'integrations/claude'
$mcpConfig = Join-Path $workflowRoot 'integrations/claude.mcp.json'
Push-Location -LiteralPath $ProjectPath
try {
    # Session-local loading only; no global settings or repository files are written.
    & claude --plugin-dir $pluginPath --mcp-config $mcpConfig
    exit $LASTEXITCODE
} finally { Pop-Location }
