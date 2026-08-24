# EdgeLink Node-RED launcher (with console log capture)
# Loads EDGE_* credentials from User environment variables, then starts Node-RED.
# Maintain credentials via: setx EDGE_API_KEY "..." etc.
$keys = @('EDGE_API_KEY','EDGE_BACKEND_USER','EDGE_BACKEND_PASS','EDGE_BOOTSTRAP_SECRET','EDGE_PG_PASSWORD','EDGE_MQTT_USERNAME','EDGE_MQTT_PASSWORD')
foreach ($k in $keys) {
    $v = [Environment]::GetEnvironmentVariable($k, 'User')
    if ($v) { Set-Item "Env:$k" $v } else { Write-Warning "$k is not set in User env" }
}
New-Item -ItemType Directory -Force 'D:\nodered\logs' | Out-Null
Set-Location 'D:\nodered\data'
Write-Host "Starting Node-RED (userDir=D:\nodered\data), log -> D:\nodered\logs\nodered_console.log"
& 'D:\nodered\node.exe' 'D:\nodered\node_modules\node-red\red.js' --userDir 'D:\nodered\data' *> 'D:\nodered\logs\nodered_console.log'
