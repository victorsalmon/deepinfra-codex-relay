param(
  [string]$Profile = "dev-daily-fixed",
  [string]$Region = "ca-central-1",
  [string]$SecretId = "ClockLobster/Agents/Admin"
)

$ErrorActionPreference = "Stop"
$wrapper = "C:\Repos\saas-modules\scripts\with-aws-secret.mjs"
node $wrapper --profile $Profile --region $Region --secret-id $SecretId --env DEEPINFRA_TOKEN -- node .\src\server.mjs
