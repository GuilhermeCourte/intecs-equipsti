# ============================================================
#  Tactical RMM - verifica o estado do "Abrir chamado" na maquina.
#
#  SOMENTE LEITURA: nao instala, nao remove, nao mexe em nada. Serve para
#  auditar o parque ("quem esta desatualizado?") antes de sair rodando o
#  instalador. Quem instala/atualiza e o instalar-abrir-chamado.ps1, que ja
#  faz sozinho o detectar -> desinstalar antigo -> instalar novo.
#
#  CODIGO DE SAIDA (o RMM alerta em cima disso):
#    0 = tudo certo, na versao esperada
#    1 = precisa de acao (nao instalado, desatualizado ou duplicado)
#
#  ATENCAO: mantenha VERSAO_ESPERADA igual ao VERSAO do instalador.
#
#  ASCII puro de proposito (ver comentario no instalador).
# ============================================================

$ErrorActionPreference = 'Continue'

$VERSAO_ESPERADA = '1.0.3'
$NOME_APP = 'AbrirChamado'

$HKLM = [Microsoft.Win32.RegistryHive]::LocalMachine
$HKCU = [Microsoft.Win32.RegistryHive]::CurrentUser

$programFiles = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
$pastaMaquina = Join-Path $programFiles 'Intecs\AbrirChamado'
$pastaUsuario = Join-Path $env:LOCALAPPDATA 'Intecs\AbrirChamado'

function Get-Instalacao {
  param($h, $pasta, $rotulo)
  $versao = $null; $url = $null; $autostart = $null
  try {
    $raiz = [Microsoft.Win32.RegistryKey]::OpenBaseKey($h, [Microsoft.Win32.RegistryView]::Registry64)
    $k = $raiz.OpenSubKey('SOFTWARE\Intecs\Chamados')
    if ($k) { $versao = $k.GetValue('Versao'); $url = $k.GetValue('Url'); $k.Close() }
    $run = $raiz.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Run')
    if ($run) { $autostart = $run.GetValue('IntecsAbrirChamado'); $run.Close() }
  } catch { }
  $arquivo = Join-Path $pasta "$NOME_APP.exe"
  [PSCustomObject]@{
    Rotulo = $rotulo; Pasta = $pasta; Versao = $versao; Url = $url
    Autostart = $autostart
    TemExe = (Test-Path $arquivo)
    Presente = ((Test-Path $arquivo) -or $versao -or $autostart)
  }
}

function Mostrar {
  param($i)
  Write-Output ("--- {0} ---" -f $i.Rotulo)
  if (-not $i.Presente) { Write-Output "  nao instalado"; return }
  Write-Output ("  versao    : " + $(if ($i.Versao) { $i.Versao } else { 'desconhecida' }))
  Write-Output ("  executavel: " + $(if ($i.TemExe) { $i.Pasta } else { 'AUSENTE (instalacao quebrada)' }))
  Write-Output ("  autostart : " + $(if ($i.Autostart) { 'sim' } else { 'NAO' }))
  Write-Output ("  url       : " + $(if ($i.Url) { $i.Url } else { '(padrao do app)' }))
}

Write-Output "===== Abrir chamado - estado nesta maquina ====="
Write-Output ("Versao esperada: $VERSAO_ESPERADA")
Write-Output ("Executando como: " + [Security.Principal.WindowsIdentity]::GetCurrent().Name)
Write-Output ""

$noMaquina = Get-Instalacao $HKLM $pastaMaquina 'ESCOPO MAQUINA (Program Files + HKLM)'
$noUsuario = Get-Instalacao $HKCU $pastaUsuario 'ESCOPO USUARIO (perfil + HKCU)'
Mostrar $noMaquina
Mostrar $noUsuario

Write-Output ""
Write-Output "--- agente Tactical ---"
$agentId = $null
try {
  $raiz = [Microsoft.Win32.RegistryKey]::OpenBaseKey($HKLM, [Microsoft.Win32.RegistryView]::Registry64)
  $k = $raiz.OpenSubKey('SOFTWARE\TacticalRMM')
  if ($k) { $agentId = $k.GetValue('AgentID'); $k.Close() }
} catch { }
Write-Output ("  AgentID: " + $(if ($agentId) { $agentId } else { 'AUSENTE - o chamado nascera sem equipamento' }))

Write-Output ""
Write-Output "--- app em execucao ---"
$proc = Get-Process -Name $NOME_APP -ErrorAction SilentlyContinue
Write-Output ("  " + $(if ($proc) { "rodando (pid " + ($proc.Id -join ', ') + ")" } else { "parado - sobe no proximo logon" }))

# ---------- Veredito ----------
Write-Output ""
Write-Output "===== VEREDITO ====="
$acao = $false

if ($noMaquina.Presente -and $noUsuario.Presente) {
  Write-Output "DUPLICADO: existe instalacao nos dois escopos - duas entradas de autostart."
  Write-Output "  -> rode o instalador (ele consolida em um escopo so)"
  $acao = $true
}
elseif (-not $noMaquina.Presente -and -not $noUsuario.Presente) {
  Write-Output "NAO INSTALADO."
  Write-Output "  -> rode o instalador"
  $acao = $true
}
else {
  $atual = if ($noMaquina.Presente) { $noMaquina } else { $noUsuario }
  if (-not $atual.TemExe) {
    Write-Output "QUEBRADO: registro presente, executavel ausente."
    Write-Output "  -> rode o instalador"
    $acao = $true
  }
  elseif ($atual.Versao -ne $VERSAO_ESPERADA) {
    Write-Output ("DESATUALIZADO: versao {0}, esperada {1}." -f `
      $(if ($atual.Versao) { $atual.Versao } else { 'desconhecida' }), $VERSAO_ESPERADA)
    Write-Output "  -> rode o instalador (ele desinstala a antiga antes de por a nova)"
    $acao = $true
  }
  elseif (-not $atual.Autostart) {
    Write-Output "SEM AUTOSTART: instalado e atualizado, mas nao sobe sozinho."
    Write-Output "  -> rode o instalador"
    $acao = $true
  }
  else {
    Write-Output ("OK: versao $VERSAO_ESPERADA instalada no " + $atual.Rotulo + ", com autostart.")
  }
}

# Nota importante para leitura do resultado no RMM: rodando como SYSTEM, o
# "escopo usuario" lido aqui e o do proprio SYSTEM, e nao o da pessoa logada.
# Uma sobra no perfil do usuario final so aparece rodando na sessao dele.
if ([Security.Principal.WindowsIdentity]::GetCurrent().IsSystem) {
  Write-Output ""
  Write-Output "NOTA: rodando como SYSTEM, o escopo USUARIO lido e o do SYSTEM."
  Write-Output "      Sobras no perfil de quem usa a maquina so aparecem na sessao dela."
}

if ($acao) { exit 1 } else { exit 0 }
