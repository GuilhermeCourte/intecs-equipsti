# ============================================================
#  Tactical RMM — remove o "Abrir chamado" da bandeja.
#  Desfaz tudo que o instalar-abrir-chamado.ps1 criou.
#  Rodar como SYSTEM.
# ============================================================

$ErrorActionPreference = 'Continue'

$programFiles = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
$destino = Join-Path $programFiles 'Intecs\AbrirChamado'

function Get-Hklm64 {
  [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::LocalMachine,
    [Microsoft.Win32.RegistryView]::Registry64)
}

Get-Process -Name 'AbrirChamado' -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Output "Encerrando pid $($_.Id)"
  try { $_.Kill(); $_.WaitForExit(5000) } catch { }
}

$hklm = Get-Hklm64

$run = $hklm.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Run', $true)
if ($run) {
  if ($run.GetValue('IntecsAbrirChamado')) {
    $run.DeleteValue('IntecsAbrirChamado')
    Write-Output 'Autostart removido.'
  }
  $run.Close()
}

$intecs = $hklm.OpenSubKey('SOFTWARE\Intecs', $true)
if ($intecs) {
  if ($intecs.OpenSubKey('Chamados')) {
    $intecs.DeleteSubKeyTree('Chamados')
    Write-Output 'Chave HKLM\SOFTWARE\Intecs\Chamados removida.'
  }
  $intecs.Close()
}

if (Test-Path $destino) {
  Remove-Item $destino -Recurse -Force
  Write-Output "Pasta removida: $destino"
}

Write-Output 'Desinstalado.'
exit 0
