# EdgeLink Node-RED launcher
# Loads EDGE_* credentials from User environment variables, then starts Node-RED.
# Maintain credentials via: setx EDGE_API_KEY "..." / EDGE_BACKEND_PASS / EDGE_PG_PASSWORD / EDGE_MQTT_USERNAME / EDGE_MQTT_PASSWORD / EDGE_BOOTSTRAP_SECRET
$keys = @('EDGE_API_KEY','EDGE_BACKEND_USER','EDGE_BACKEND_PASS','EDGE_BOOTSTRAP_SECRET','EDGE_PG_PASSWORD','EDGE_MQTT_USERNAME','EDGE_MQTT_PASSWORD')
foreach ($k in $keys) {
    $v = [Environment]::GetEnvironmentVariable($k, 'User')
    if ($v) { Set-Item "Env:$k" $v } else { Write-Warning "$k is not set in User env" }
}
Set-Location 'D:\nodered\data'
Write-Host "Starting Node-RED (userDir=D:\nodered\data) ..."
& 'D:\nodered\node.exe' 'D:\nodered\node_modules\node-red\red.js' --userDir 'D:\nodered\data'
