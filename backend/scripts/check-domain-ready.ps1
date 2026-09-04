param(
    [string]$Domain = "taiyizhi.com",
    [string]$ExpectedPublicIp = "120.238.191.146"
)

$dnsResult = Resolve-DnsName -Name $Domain -Type A -ErrorAction SilentlyContinue
$resolvedIps = @($dnsResult | Select-Object -ExpandProperty IPAddress -ErrorAction SilentlyContinue)

Write-Host "Domain: $Domain"
Write-Host "Resolved A records: $($resolvedIps -join ', ')"
Write-Host "Expected public IP: $ExpectedPublicIp"

foreach ($port in 80, 443, 1883) {
    $result = Test-NetConnection $Domain -Port $port -WarningAction SilentlyContinue
    $status = if ($result.TcpTestSucceeded) { "OPEN" } else { "CLOSED" }
    Write-Host ("Port {0}: {1}" -f $port, $status)
}
