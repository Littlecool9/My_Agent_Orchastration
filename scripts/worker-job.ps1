param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference = 'Stop'
$request = [IO.File]::ReadAllText($RequestFile) | ConvertFrom-Json
Add-Type -Path (Join-Path $PSScriptRoot 'worker-job.cs')
$result = [WorkerJob]::Run([string]$request.command, [string[]]$request.args, [int]$request.memoryLimitMB, [string]$request.reportFile)
if ($result.Error) { [Console]::Error.WriteLine($result.Status + ': ' + $result.Error) }
exit $result.ExitCode
