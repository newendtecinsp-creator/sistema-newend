# Backup diario do Controle OS
# Origem: C:\ControleOS\data
# Destino: C:\ControleOS_Backups
# Mantem 365 dias de copias.

$ErrorActionPreference = "Stop"

$source = "C:\ControleOS\data"
$backupRoot = "C:\ControleOS_Backups"
$stamp = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$destination = Join-Path $backupRoot $stamp
$log = Join-Path $backupRoot "backup-log.txt"

try {
    if (-not (Test-Path -LiteralPath $source -PathType Container)) {
        throw "Pasta de dados nao encontrada: $source"
    }

    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null

    # Aguarda dados.json ficar sem alteracoes por alguns segundos.
    $dataFile = Join-Path $source "dados.json"
    if (Test-Path -LiteralPath $dataFile -PathType Leaf) {
        $stable = $false
        for ($attempt = 0; $attempt -lt 12; $attempt++) {
            $first = Get-Item -LiteralPath $dataFile
            Start-Sleep -Seconds 3
            $second = Get-Item -LiteralPath $dataFile
            if ($first.Length -eq $second.Length -and
                $first.LastWriteTimeUtc -eq $second.LastWriteTimeUtc) {
                $stable = $true
                break
            }
        }
        if (-not $stable) {
            throw "O arquivo dados.json continua sendo alterado. Backup cancelado para evitar uma copia inconsistente."
        }
    }

    New-Item -ItemType Directory -Path $destination -Force | Out-Null

    # Copia a pasta data inteira, incluindo backups e auditoria existentes.
    & robocopy $source $destination /E /COPY:DAT /DCOPY:DAT /R:2 /W:3 /XJ /NFL /NDL /NP
    $rc = $LASTEXITCODE
    if ($rc -ge 8) {
        throw "Falha na copia (codigo Robocopy $rc)."
    }

    if ((Test-Path -LiteralPath $dataFile -PathType Leaf) -and
        -not (Test-Path -LiteralPath (Join-Path $destination "dados.json") -PathType Leaf)) {
        throw "A copia terminou sem o arquivo dados.json."
    }

    Add-Content -LiteralPath $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - SUCESSO - $destination"

    # Remove somente copias cujo nome indica mais de 365 dias.
    $cutoff = (Get-Date).AddDays(-365)
    Get-ChildItem -LiteralPath $backupRoot -Directory |
        Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$' } |
        ForEach-Object {
            $folderDate = [datetime]::MinValue
            $parsed = [datetime]::TryParseExact(
                $_.Name,
                "yyyy-MM-dd_HH-mm-ss",
                [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::None,
                [ref]$folderDate
            )
            if ($parsed -and $folderDate -lt $cutoff) {
                Remove-Item -LiteralPath $_.FullName -Recurse -Force
            }
        }

    exit 0
}
catch {
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    Add-Content -LiteralPath $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') - ERRO - $($_.Exception.Message)"
    exit 1
}
