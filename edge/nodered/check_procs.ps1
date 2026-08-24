Get-Process | Where-Object { $_.ProcessName -match '^(node|powershell)$' } | Select-Object Id, ProcessName, StartTime | Format-Table -AutoSize
