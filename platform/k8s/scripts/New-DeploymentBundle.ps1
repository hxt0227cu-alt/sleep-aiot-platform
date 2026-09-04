[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidatePattern('^registry-vpc\.[a-z0-9-]+\.aliyuncs\.com$')][string]$AcrPullRegistry,
  [Parameter(Mandatory = $true)][string]$AcrNamespace,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9-]+$')][string]$SlbCertificateId,
  [Parameter(Mandatory = $true)][ValidatePattern('^sha256:[0-9a-f]{64}$')][string]$BackendDigest,
  [Parameter(Mandatory = $true)][ValidatePattern('^sha256:[0-9a-f]{64}$')][string]$AgentDigest,
  [Parameter(Mandatory = $true)][ValidatePattern('^sha256:[0-9a-f]{64}$')][string]$FeatureDigest,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9./]+$')][string]$BackendDatabaseCidr,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9./]+$')][string]$AgentDatabaseCidr,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9./]+$')][string]$TemporalDatabaseCidr,
  [string]$OutputPath = 'platform/k8s/rendered/alicloud-validation.yaml'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$overlay = Join-Path $repositoryRoot 'platform/k8s/overlays/alicloud-validation'
$output = if ([System.IO.Path]::IsPathRooted($OutputPath)) {
  $OutputPath
} else {
  Join-Path $repositoryRoot $OutputPath
}
$zeroDigest = 'sha256:' + ('0' * 64)

if ($BackendDigest -eq $zeroDigest -or $AgentDigest -eq $zeroDigest -or $FeatureDigest -eq $zeroDigest) {
  throw 'Image digests must identify built ACR artifacts; the zero digest is not deployable.'
}

$kubectl = Get-Command kubectl -ErrorAction SilentlyContinue
if ($kubectl) {
  $rendered = (& $kubectl.Source kustomize $overlay | Out-String)
} else {
  $wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
  if (-not $wsl) { throw 'kubectl is required either on Windows PATH or inside WSL.' }
  if ($overlay -notmatch '^([A-Za-z]):\\(.*)$') {
    throw "Cannot translate overlay path for WSL: $overlay"
  }
  $drive = $Matches[1].ToLowerInvariant()
  $relativePath = $Matches[2].Replace('\', '/')
  $wslOverlay = "/mnt/$drive/$relativePath"
  $rendered = (& $wsl.Source kubectl kustomize $wslOverlay | Out-String)
}
if ($LASTEXITCODE -ne 0) { throw 'kubectl kustomize failed.' }

$rendered = $rendered.Replace('REPLACE_WITH_ACR_NAMESPACE', $AcrNamespace)
$rendered = $rendered.Replace('registry-vpc.cn-hangzhou.aliyuncs.com', $AcrPullRegistry)
$rendered = $rendered.Replace('REPLACE_WITH_SLB_CERT_ID', $SlbCertificateId)
$imageDigests = [ordered]@{
  "${AcrNamespace}/backend-api@$zeroDigest" = "${AcrNamespace}/backend-api@$BackendDigest"
  "${AcrNamespace}/agent-service@$zeroDigest" = "${AcrNamespace}/agent-service@$AgentDigest"
  "${AcrNamespace}/feature-service@$zeroDigest" = "${AcrNamespace}/feature-service@$FeatureDigest"
}
foreach ($entry in $imageDigests.GetEnumerator()) {
  if (-not $rendered.Contains($entry.Key)) {
    throw "Rendered manifest is missing expected image: $($entry.Key)"
  }
  $rendered = $rendered.Replace($entry.Key, $entry.Value)
}

$replacements = [ordered]@{
  '192.0.2.10/32' = $BackendDatabaseCidr
  '192.0.2.11/32' = $AgentDatabaseCidr
  '192.0.2.12/32' = $TemporalDatabaseCidr
}
foreach ($entry in $replacements.GetEnumerator()) {
  $rendered = $rendered.Replace($entry.Key, $entry.Value)
}

$outputDirectory = Split-Path -Parent $output
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
[System.IO.File]::WriteAllText($output, $rendered, [System.Text.UTF8Encoding]::new($false))
& (Join-Path $PSScriptRoot 'Test-DeploymentBundle.ps1') -ManifestPath $output
if ($LASTEXITCODE -ne 0) { throw 'Deployment bundle validation failed.' }
Write-Host "Generated deployable bundle: $output"
