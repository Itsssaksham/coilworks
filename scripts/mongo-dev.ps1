<#
.SYNOPSIS
  Starts a local single-node MongoDB replica set for Coilworks on port 27018.

.DESCRIPTION
  Coilworks needs change streams (live dashboard) and transactions (restock
  commits), and both require an oplog - which a standalone mongod does not have.

  This runs a SECOND mongod instance with its own data directory on port 27018.
  It does not touch a MongoDB service you may already have on 27017.

  Prefer `docker compose up -d` if you have Docker running; this script is the
  no-Docker path.

.PARAMETER Stop
  Stop the Coilworks mongod instance instead of starting it.
#>
param([switch]$Stop)

$ErrorActionPreference = 'Stop'

$port    = 27018
$root    = Split-Path -Parent $PSScriptRoot
$dbPath  = Join-Path $root '.mongo-data'
$logPath = Join-Path $root '.mongo-data\mongod.log'

function Get-CoilworksMongo {
    Get-CimInstance Win32_Process -Filter "Name = 'mongod.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*--port $port*" }
}

if ($Stop) {
    $proc = Get-CoilworksMongo
    if ($proc) { Stop-Process -Id $proc.ProcessId -Force; "Stopped mongod on port $port." }
    else { "No Coilworks mongod running on port $port." }
    return
}

if (Get-CoilworksMongo) { "mongod already running on port $port."; return }

$mongod = Get-ChildItem 'C:\Program Files\MongoDB\Server\*\bin\mongod.exe' -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
if (-not $mongod) { throw "mongod.exe not found under C:\Program Files\MongoDB\Server. Install MongoDB, or use docker compose up -d." }

if (-not (Test-Path $dbPath)) { New-Item -ItemType Directory -Path $dbPath -Force | Out-Null }

Start-Process -FilePath $mongod -WindowStyle Hidden -ArgumentList @(
    '--port', $port
    '--dbpath', "`"$dbPath`""
    '--replSet', 'rs0'
    '--bind_ip', '127.0.0.1'
    '--logpath', "`"$logPath`""
)

# Wait for the port to accept connections before initiating the replica set.
$deadline = (Get-Date).AddSeconds(30)
do {
    Start-Sleep -Milliseconds 400
    $up = (Test-NetConnection -ComputerName 127.0.0.1 -Port $port -WarningAction SilentlyContinue).TcpTestSucceeded
} while (-not $up -and (Get-Date) -lt $deadline)
if (-not $up) { throw "mongod did not open port $port within 30s. See $logPath" }

# Initiate once; on restarts the config is already on disk and rs.status() succeeds.
$mongosh = (Get-Command mongosh -ErrorAction SilentlyContinue).Source
if (-not $mongosh) { throw "mongosh not found on PATH - needed to initiate the replica set." }

# Passed as a --file rather than --eval: native argument parsing strips the
# double quotes out of an inline script, which breaks the JS.
& $mongosh --port $port --quiet --file (Join-Path $PSScriptRoot 'rs-init.js')
if ($LASTEXITCODE -ne 0) { throw "Replica set did not reach PRIMARY. See $logPath" }

"MongoDB ready at mongodb://127.0.0.1:$port/?replicaSet=rs0"
