[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ManifestPath
)

$ErrorActionPreference = 'Stop'
$manifest = Get-Content -Raw -LiteralPath $ManifestPath
$forbidden = @(
  'REPLACE_WITH',
  'registry.example.com',
  ('sha256:' + ('0' * 64)),
  '192.0.2.10/32',
  '192.0.2.11/32',
  '192.0.2.12/32'
)
foreach ($value in $forbidden) {
  if ($manifest.Contains($value)) { throw "Manifest contains undeployable placeholder: $value" }
}

$required = @(
  'name: backend-api',
  'type: LoadBalancer',
  'name: agent-service',
  'name: feature-service',
  'name: temporal-frontend',
  'name: redis',
  'name: clickhouse',
  'name: clickhouse-validation-init',
  'name: backend-api-to-validation-redis',
  'name: feature-service-to-validation-clickhouse',
  'ads_agent_device_sleep_features',
  'name: backend-api-secrets',
  'name: agent-service-secrets',
  'name: feature-service-secrets',
  'name: temporal-secrets'
  'name: postgres-backup-secret'
  'name: acr-pull-secret'
  'service.beta.kubernetes.io/alibaba-cloud-loadbalancer-protocol-port: https:443'
  'port: 443'
)
foreach ($value in $required) {
  if (-not $manifest.Contains($value)) { throw "Manifest is missing required deployment contract: $value" }
}

$dualReplicaCount = [regex]::Matches($manifest, '(?m)^  replicas: 2\r?$').Count
if ($dualReplicaCount -lt 4) {
  throw "Expected Backend, Agent, Feature and Temporal dual-Pod deployments; found $dualReplicaCount replica declarations."
}

$documents = [regex]::Split($manifest, '(?m)^\s*---\s*$')
function Get-DeploymentDocument([string]$name) {
  foreach ($document in $documents) {
    if (
      $document -match '(?m)^kind:\s+Deployment\s*$' -and
      $document -match "(?m)^  name:\s+$([regex]::Escape($name))\s*$"
    ) {
      return $document
    }
  }
  throw "Manifest is missing Deployment/$name."
}

foreach ($name in @('backend-api', 'agent-service', 'feature-service')) {
  $deployment = Get-DeploymentDocument $name
  if (
    $deployment -notmatch
      '(?ms)topologyKey:\s+kubernetes\.io/hostname\s*\r?\n\s+whenUnsatisfiable:\s+DoNotSchedule'
  ) {
    throw "Deployment/$name must enforce hard cross-node topology spread."
  }
}

foreach ($name in @('backend-api', 'agent-service', 'feature-service', 'temporal')) {
  $deployment = Get-DeploymentDocument $name
  if (
    $deployment -notmatch
      '(?ms)requiredDuringSchedulingIgnoredDuringExecution:.*?topologyKey:\s+kubernetes\.io/hostname'
  ) {
    throw "Deployment/$name must enforce required cross-node pod anti-affinity."
  }
}

Write-Host 'Deployment bundle contract passed.'
