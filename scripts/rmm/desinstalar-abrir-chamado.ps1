# ============================================================
#  Tactical RMM - remove o "Abrir chamado" da bandeja.
#
#  Limpa os DOIS escopos possiveis (maquina e usuario), porque um teste
#  manual sem privilegio instala no perfil do usuario e um deploy pelo RMM
#  instala em Program Files. Sem privilegio, so o escopo de usuario e
#  removido - e o script avisa.
#
#  ASCII puro de proposito (ver comentario no instalador).
# ============================================================

$ErrorActionPreference = 'Continue'

$NOME_APP = 'AbrirChamado'

$ehAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Get-Process -Name $NOME_APP -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Output "Encerrando pid $($_.Id)"
  try { $_.Kill(); [void]$_.WaitForExit(5000) } catch { }
}

function Remove-Escopo {
  param($hive, $pasta, $rotulo)

  $raiz = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, [Microsoft.Win32.RegistryView]::Registry64)

  $run = $raiz.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Run', $true)
  if ($run) {
    if ($run.GetValue('IntecsAbrirChamado')) {
      $run.DeleteValue('IntecsAbrirChamado')
      Write-Output "[$rotulo] autostart removido."
    }
    $run.Close()
  }

  $intecs = $raiz.OpenSubKey('SOFTWARE\Intecs', $true)
  if ($intecs) {
    if ($intecs.OpenSubKey('Chamados')) {
      $intecs.DeleteSubKeyTree('Chamados')
      Write-Output "[$rotulo] chave SOFTWARE\Intecs\Chamados removida."
    }
    $intecs.Close()
  }

  if ($pasta -and (Test-Path $pasta)) {
    Remove-Item -LiteralPath $pasta -Recurse -Force
    Write-Output "[$rotulo] pasta removida: $pasta"
  }
}

# Escopo do usuario atual: sempre da para limpar.
Remove-Escopo ([Microsoft.Win32.RegistryHive]::CurrentUser) `
  (Join-Path $env:LOCALAPPDATA 'Intecs\AbrirChamado') 'usuario'

# Escopo da maquina: precisa de privilegio.
if ($ehAdmin) {
  $programFiles = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
  Remove-Escopo ([Microsoft.Win32.RegistryHive]::LocalMachine) `
    (Join-Path $programFiles 'Intecs\AbrirChamado') 'maquina'
} else {
  Write-Output "AVISO: sem privilegio de administrador - o escopo de MAQUINA nao foi tocado."
  Write-Output "Rode como administrador (ou pelo RMM) para remover de Program Files e HKLM."
}

Write-Output 'Desinstalado.'
exit 0
