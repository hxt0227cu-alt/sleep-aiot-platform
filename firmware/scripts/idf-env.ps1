param(
  [string]$IdfPath = "C:\esp\v5.4.1\esp-idf",
  [string]$PythonEnv = "C:\Users\TX\.espressif\python_env\idf5.4_py3.11_env",
  [string]$TempPath = "$env:LOCALAPPDATA\Temp"
)

$ErrorActionPreference = "Stop"

if (!(Test-Path $IdfPath)) {
  throw "ESP-IDF path not found: $IdfPath"
}

if (!(Test-Path "$PythonEnv\Scripts\python.exe")) {
  throw "ESP-IDF Python environment not found: $PythonEnv"
}

if (!(Test-Path $TempPath)) {
  New-Item -ItemType Directory -Force -Path $TempPath | Out-Null
}

$env:TEMP = $TempPath
$env:TMP = $TempPath
$env:PATH = "$PythonEnv\Scripts;$env:PATH"

. "$IdfPath\export.ps1"
