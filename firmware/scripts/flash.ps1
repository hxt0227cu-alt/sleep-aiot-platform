param(
  [string]$Port = "",
  [switch]$Monitor
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Resolve-Path "$PSScriptRoot\.."

. "$PSScriptRoot\idf-env.ps1"

function Invoke-Idf {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$IdfArgs)
  & idf.py @IdfArgs
  if ($LASTEXITCODE -ne 0) {
    throw "idf.py $($IdfArgs -join ' ') failed with exit code $LASTEXITCODE"
  }
}

$IdfArgs = @()
if ($Port) {
  $IdfArgs += @("-p", $Port)
}

$IdfArgs += "flash"
if ($Monitor) {
  $IdfArgs += "monitor"
}

Push-Location $ProjectRoot
try {
  Invoke-Idf @IdfArgs
}
finally {
  Pop-Location
}
