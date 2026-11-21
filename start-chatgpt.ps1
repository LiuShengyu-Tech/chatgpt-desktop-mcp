# Start the ChatGPT desktop app with the local debugging port that the
# chatgpt-desktop MCP server uses. The port listens on 127.0.0.1 only.
param([int]$Port = 9222, [switch]$Restart)

$running = Get-Process ChatGPT -ErrorAction SilentlyContinue
if ($running) {
    $ok = $false
    try { Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 5 | Out-Null; $ok = $true } catch {}
    if ($ok) { Write-Host "ChatGPT is already running with the debugging port $Port."; exit 0 }
    if (-not $Restart) {
        Write-Host "ChatGPT is running without the debugging port. Close it first, or run again with -Restart."
        exit 1
    }
    $running | Stop-Process -Force
    Start-Sleep -Seconds 2
}

$pkg = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1
if (-not $pkg) { $pkg = Get-AppxPackage *ChatGPT* | Select-Object -First 1 }
if (-not $pkg) { Write-Error 'ChatGPT desktop app not found.'; exit 1 }
$exe = Join-Path $pkg.InstallLocation 'app\ChatGPT.exe'

Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$Port", "--remote-allow-origins=http://127.0.0.1:$Port"
Write-Host "Started ChatGPT with debugging port $Port."
