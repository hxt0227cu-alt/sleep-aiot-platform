param(
  [string]$Target = "esp32s3"
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

Push-Location $ProjectRoot
try {
  Invoke-Idf set-target $Target
  Invoke-Idf build
}
finally {
  Pop-Location
}
