# ============================================================
#  Tactical RMM - instala o "Abrir chamado" na bandeja do sistema.
#
#  POR QUE ISSO EXISTE
#  O navegador nao tem como descobrir em que maquina esta rodando: nao le
#  hostname, nao le registro, e o agente do Tactical nao escuta em porta
#  nenhuma. Detectar por IP nao serve - atras de NAT a rede inteira sai pelo
#  mesmo endereco (medimos: 6 maquinas num IP so). Entao a identidade precisa
#  ser ENTREGUE a pagina, e quem sabe a identidade e o proprio agente, que
#  grava o AgentID em HKLM\SOFTWARE\TacticalRMM.
#
#  Este app fica na bandeja e, ao ser clicado, le esse AgentID NA HORA e abre
#  a pagina de chamados com ele na URL. Ler no clique (e nao na instalacao)
#  faz a maquina reinstalada se corrigir sozinha.
#
#  AUTOCONTIDO: compila na propria maquina com o csc.exe que ja vem no
#  Windows. Nao precisa transferir binario nem instalar .NET.
#
#  DOIS MODOS, escolhidos automaticamente:
#    - Com privilegio (SYSTEM pelo RMM, ou PowerShell como administrador):
#      instala em Program Files e vale para TODOS os usuarios da maquina.
#    - Sem privilegio (teste manual): instala no perfil do usuario atual.
#      Nao precisa de admin, e serve so para quem rodou.
#
#  Pode rodar quantas vezes quiser - so recompila quando a versao muda.
#
#  ARQUIVO EM ASCII PURO de proposito: acento sem BOM vira mojibake no
#  PowerShell 5.1 e no copiar/colar para o editor de scripts do RMM.
# ============================================================

$ErrorActionPreference = 'Stop'

# ---------- Configuracao ----------
$VERSAO   = '1.0.3'
$URL_BASE = 'https://gestaoti.intecsbr.org/chamados'
$NOME_APP = 'AbrirChamado'
# ----------------------------------

# SYSTEM (como o RMM roda) tambem carrega o grupo Administradores no token,
# entao esta checagem cobre os dois casos de instalacao para a maquina toda.
$ehAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# Em processo de 32 bits $env:ProgramFiles apontaria para "Program Files (x86)".
$programFiles  = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
$pastaMaquina  = Join-Path $programFiles 'Intecs\AbrirChamado'
$pastaUsuario  = Join-Path $env:LOCALAPPDATA 'Intecs\AbrirChamado'

$HKLM = [Microsoft.Win32.RegistryHive]::LocalMachine
$HKCU = [Microsoft.Win32.RegistryHive]::CurrentUser

if ($ehAdmin) {
  $destino = $pastaMaquina; $hive = $HKLM; $escopo = 'MAQUINA (todos os usuarios)'
} else {
  $destino = $pastaUsuario; $hive = $HKCU; $escopo = 'USUARIO ATUAL (sem privilegio de administrador)'
}

$exe = Join-Path $destino "$NOME_APP.exe"

function Get-Raiz {
  param($h = $hive)
  # Registry64 evita cair em Wow6432Node se o PowerShell for de 32 bits.
  [Microsoft.Win32.RegistryKey]::OpenBaseKey($h, [Microsoft.Win32.RegistryView]::Registry64)
}

# Le o que existe num escopo, sem alterar nada.
function Get-Instalacao {
  param($h, $pasta, $rotulo)
  $versao = $null
  try {
    $k = (Get-Raiz $h).OpenSubKey('SOFTWARE\Intecs\Chamados')
    if ($k) { $versao = $k.GetValue('Versao'); $k.Close() }
  } catch { }
  $arquivo = Join-Path $pasta "$NOME_APP.exe"
  $temExe = Test-Path $arquivo
  [PSCustomObject]@{
    Rotulo   = $rotulo
    Hive     = $h
    Pasta    = $pasta
    Presente = ($temExe -or $versao)
    Versao   = $versao
    TemExe   = $temExe
  }
}

# Remove um escopo por completo (registro + pasta). Usado tanto para atualizar
# quanto para limpar instalacao no escopo errado.
function Remove-Instalacao {
  param($inst)
  $raiz = Get-Raiz $inst.Hive
  $run = $raiz.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Run', $true)
  if ($run) {
    if ($run.GetValue('IntecsAbrirChamado')) { $run.DeleteValue('IntecsAbrirChamado') }
    $run.Close()
  }
  $intecs = $raiz.OpenSubKey('SOFTWARE\Intecs', $true)
  if ($intecs) {
    if ($intecs.OpenSubKey('Chamados')) { $intecs.DeleteSubKeyTree('Chamados') }
    $intecs.Close()
  }
  if (Test-Path $inst.Pasta) { Remove-Item -LiteralPath $inst.Pasta -Recurse -Force }
  Write-Output ("  removido: " + $inst.Rotulo + " (versao " + $(if ($inst.Versao) { $inst.Versao } else { 'desconhecida' }) + ")")
}

# Quem esta usando a maquina agora (vazio se ninguem logado).
function Get-UsuarioLogado {
  $u = (Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue).UserName
  if ($u) { return $u }
  # Fallback: dono do explorer.exe da sessao interativa.
  try {
    $exp = Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" -ErrorAction Stop | Select-Object -First 1
    if ($exp) {
      $dono = Invoke-CimMethod -InputObject $exp -MethodName GetOwner -ErrorAction Stop
      if ($dono.User) { return ($dono.Domain + '\' + $dono.User) }
    }
  } catch { }
  return $null
}

# Sobe o app JA, sem esperar o proximo logon.
#
# Rodando como SYSTEM (o caso do RMM) um Start-Process comum nasceria na
# sessao 0, invisivel para quem esta na frente do PC. O jeito de cruzar para a
# sessao da pessoa e uma tarefa agendada marcada como interativa (/IT): o
# Windows a executa dentro da sessao dela. Criamos, disparamos e apagamos.
function Start-AppAgora {
  param($caminhoExe)

  if (-not $ehAdmin) {
    # Sem privilegio ja estamos na sessao do usuario - direto mesmo.
    Start-Process $caminhoExe
  } else {
    $usuario = Get-UsuarioLogado
    if (-not $usuario) {
      Write-Output "Ninguem logado agora - o icone aparece no proximo logon."
      return $false
    }
    $tarefa = 'IntecsAbrirChamadoPrimeiraExecucao'
    # Cmdlets em vez do schtasks.exe de proposito: o executavel nativo emite um
    # aviso em stderr quando /ST fica no passado e, com ErrorActionPreference
    # 'Stop', esse aviso virava erro terminante e abortava a instalacao.
    # Aqui tambem nao existe horario - a tarefa nasce sem gatilho e e disparada
    # na mao, entao nao ha o que ficar no passado.
    try {
      # Sobra de execucao anterior interrompida.
      Unregister-ScheduledTask -TaskName $tarefa -Confirm:$false -ErrorAction SilentlyContinue

      $acao = New-ScheduledTaskAction -Execute $caminhoExe
      # LogonType Interactive: roda com o token da sessao da pessoa (e so
      # quando ela esta logada), que e justamente o que faz o icone aparecer.
      $principal = New-ScheduledTaskPrincipal -UserId $usuario -LogonType Interactive
      Register-ScheduledTask -TaskName $tarefa -Action $acao -Principal $principal -Force -ErrorAction Stop | Out-Null
      Start-ScheduledTask -TaskName $tarefa -ErrorAction Stop
      Start-Sleep -Seconds 3
      Unregister-ScheduledTask -TaskName $tarefa -Confirm:$false -ErrorAction SilentlyContinue
      Write-Output "Disparado na sessao de $usuario."
    } catch {
      # Instalacao ja esta completa; nao subir agora nao invalida nada.
      Write-Output ("Nao foi possivel disparar na sessao do usuario: " + $_.Exception.Message)
      try { Unregister-ScheduledTask -TaskName $tarefa -Confirm:$false -ErrorAction SilentlyContinue } catch { }
      return $false
    }
  }

  Start-Sleep -Seconds 2
  return [bool](Get-Process -Name $NOME_APP -ErrorAction SilentlyContinue)
}

Write-Output "Escopo desta execucao: $escopo"

# ---------- O que ja existe nesta maquina ----------
$noMaquina = Get-Instalacao $HKLM $pastaMaquina 'escopo MAQUINA'
$noUsuario = Get-Instalacao $HKCU $pastaUsuario 'escopo USUARIO'

foreach ($i in @($noMaquina, $noUsuario)) {
  if ($i.Presente) {
    Write-Output ("Encontrado: {0} - versao {1}{2}" -f $i.Rotulo,
      $(if ($i.Versao) { $i.Versao } else { 'desconhecida' }),
      $(if (-not $i.TemExe) { ' (registro sem executavel - instalacao quebrada)' } else { '' }))
  }
}
if (-not $noMaquina.Presente -and -not $noUsuario.Presente) {
  Write-Output "Nenhuma instalacao encontrada."
}

$alvo = if ($ehAdmin) { $noMaquina } else { $noUsuario }
$outro = if ($ehAdmin) { $noUsuario } else { $noMaquina }

# Ja esta certo e nao ha sobra no outro escopo? Entao nao ha o que fazer.
# Recompilar a toa geraria um binario com hash novo a cada execucao da policy,
# zerando a reputacao dele no antivirus toda vez.
if ($alvo.Versao -eq $VERSAO -and $alvo.TemExe -and -not $outro.Presente) {
  Write-Output "Ja esta na versao $VERSAO no escopo certo."
  # Instalado e correto, mas fora do ar (usuario fechou pelo gerenciador de
  # tarefas, ou logou antes da instalacao): sobe de novo em vez de esperar o
  # proximo logon. E o que torna a policy autocorretiva.
  if (Get-Process -Name $NOME_APP -ErrorAction SilentlyContinue) {
    Write-Output "App em execucao. Nada a fazer."
  } else {
    Write-Output "App fora do ar - iniciando."
    if (Start-AppAgora (Join-Path $alvo.Pasta "$NOME_APP.exe")) {
      Write-Output "OK, icone na bandeja."
    }
  }
  exit 0
}

# ---------- Encerrar o app antes de mexer nos arquivos ----------
Get-Process -Name $NOME_APP -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Output "Encerrando instancia em execucao (pid $($_.Id))"
  # WaitForExit(int) devolve bool; sem o [void] ele vaza um "True" no log.
  try { $_.Kill(); [void]$_.WaitForExit(5000) } catch { }
}

# ---------- Desinstalar o que estiver sobrando ou desatualizado ----------
# Instalacao no OUTRO escopo sempre sai: duas conviverem significa duas
# entradas de autostart disputando o mesmo icone.
if ($outro.Presente) {
  if ($ehAdmin -or $outro.Hive -eq $HKCU) {
    Write-Output "Removendo instalacao no escopo errado:"
    Remove-Instalacao $outro
  } else {
    Write-Output "AVISO: existe instalacao no escopo MAQUINA e falta privilegio para remove-la."
    Write-Output "       Rode pelo RMM (SYSTEM) para consolidar em um escopo so."
  }
}

if ($alvo.Presente -and ($alvo.Versao -ne $VERSAO -or -not $alvo.TemExe)) {
  Write-Output ("Versao {0} e diferente da desejada ({1}) - desinstalando antes de instalar:" -f `
    $(if ($alvo.Versao) { $alvo.Versao } else { 'desconhecida' }), $VERSAO)
  try { Remove-Instalacao $alvo } catch {
    Write-Output "ERRO ao remover a versao anterior: $($_.Exception.Message)"
    exit 1
  }
}

Write-Output "Instalando $NOME_APP $VERSAO em $destino"

# ---------- Localizar o compilador que ja vem no Windows ----------
$csc = @(
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $csc) {
  Write-Output "ERRO: csc.exe (.NET Framework 4) nao encontrado nesta maquina."
  exit 1
}
Write-Output "Compilador: $csc"

# ---------- Preparar pastas ----------
# Compila em pasta sem espaco no caminho e so depois move para o destino,
# evitando dor de cabeca com aspas nos argumentos do csc.
$tmp = Join-Path $env:TEMP 'intecs-abrirchamado-build'
if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

try {
  if (-not (Test-Path $destino)) { New-Item -ItemType Directory -Path $destino -Force | Out-Null }
} catch {
  Write-Output ""
  Write-Output "ERRO: sem permissao para criar $destino"
  Write-Output "Rode o PowerShell como administrador, ou deixe o RMM executar (ele roda como SYSTEM)."
  exit 1
}

# ---------- Logo da bandeja (PNG 32x32 embutido) ----------
$logoB64 = @(
'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMA'
'AA7DAcdvqGQAAAKASURBVFhHvZdfbtNAEMbzyC3ynj8PbZNjABepegFAQrzSihvkDalSRA9Q8ecO8AziDCCI7V17mW/jscfjWTcE'
'h5V+Wne/3ZnPs5tNOkm12Wz2dT6fh7GgeJ/r0OlmLTwFZOZbnbJt1sRTU6fuJ18sFoEbnrU+Iq9MA1VVhbIsYw+0PiY9A0+fPO4k'
'x7PUxwbJv+tBJJUsl8uOPibm4UPjCmS73z1dQic6FFkeXOWjWedcXH+oadPAodxcXwdf7avE2wW89/FvNGud5GgDV5eXTUKGq8bP'
'6B8yYRqQAdFbc6xk6EO5H5djQ9thGtABtP7i2fPOHGyD1Hmc+fXjZ0eXJCvQBKf91DqJHQNaB6wDl+/MOWDQQCpBnueNVtLbW7el'
'jFEURU9nHtyCIQMA5bcM8Hr0RZH3dOaoCuCN2BxIVQDsDRxRAZlA67IC0FMVYAqar3VmcAuAZQBvxBp6y8Ddu23Ybrfh9u0tHeS/'
'rAAHRm8ZQAV4jjRQeBc8XcV4luvRcEVnu6wTByQNSLSe06FqEvh2C3g+DqZ3PtCFHA2xUSvWoIHUos4hpGRLYSB+N5ApWhwqxMDN'
'GPt9PB1rcAsYS5fwOOamrt1P7z8ebkAmB2gpnarcjEtTco4ck3GAaWCz2TQLOYinsjoqrxxHrw2kKvDh/j6u0eOmAYBgjEyqn/Ua'
'rTuX/giCpAGAw4TDg4ASK3mcT9rQV6/eSgADX/SgBD+5MtfefPg8v3l9Y85lc9wX9Z1QUhWs5KD3q/hfYJNsQP9OsBjVgNweRr65'
'dWVHA/hfTQvHcH52HtbrdWS1WjX96uIiPuv50+n0UTSApsX/QZ26bTT4Uk86Be2bTyZ/AERUg8p2UMLXAAAAAElFTkSuQmCC'
) -join ''

$png = Join-Path $tmp 'logo.png'
[IO.File]::WriteAllBytes($png, [Convert]::FromBase64String($logoB64))

# Icone do proprio .exe (o que aparece no Explorer)
Add-Type -AssemblyName System.Drawing
$ico = Join-Path $tmp 'app.ico'
$img = [System.Drawing.Image]::FromFile($png)
$bmp = New-Object System.Drawing.Bitmap($img, 32, 32)
$icone = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
$fs = [IO.File]::Create($ico)
$icone.Save($fs)
$fs.Close(); $bmp.Dispose(); $img.Dispose()

# ---------- Codigo-fonte ----------
$fonte = @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class Program
{
    const string URL_PADRAO = "https://gestaoti.intecsbr.org/chamados";
    const string CAMINHO_CFG = @"SOFTWARE\Intecs\Chamados";

    static NotifyIcon icone;
    static DateTime ultimoClique = DateTime.MinValue;

    [STAThread]
    static void Main()
    {
        bool primeiro;
        // Sem isso, cada logon/duplo clique acumularia um icone na bandeja.
        // Tambem impede dois icones quando existe instalacao por maquina e
        // por usuario ao mesmo tempo.
        using (new Mutex(true, "Intecs.AbrirChamado.InstanciaUnica", out primeiro))
        {
            if (!primeiro) return;

            Application.EnableVisualStyles();

            icone = new NotifyIcon();
            icone.Icon = CarregarIcone();
            icone.Text = "Abrir chamado - TI Intecs";
            icone.Visible = true;
            // Sem menu de contexto de proposito: o icone serve para uma coisa
            // so, entao qualquer clique - esquerdo, direito ou do meio - abre o
            // chamado. Nao ha "Sair" para o usuario nao desligar sem querer;
            // quem remove e o desinstalador, pelo RMM.
            icone.MouseClick += delegate
            {
                // Clicar duas vezes e habito comum na bandeja; sem esta guarda
                // abririam duas abas.
                if ((DateTime.Now - ultimoClique).TotalMilliseconds < 800) return;
                ultimoClique = DateTime.Now;
                Abrir();
            };

            Application.Run();
        }
    }

    static string LerValor(RegistryHive hive, string caminho, string nome)
    {
        try
        {
            using (var raiz = RegistryKey.OpenBaseKey(hive, RegistryView.Registry64))
            using (var chave = raiz.OpenSubKey(caminho))
            {
                if (chave == null) return null;
                var valor = chave.GetValue(nome) as string;
                return string.IsNullOrEmpty(valor) ? null : valor.Trim();
            }
        }
        catch { return null; }
    }

    // AgentID gravado pelo agente Tactical. Sempre em HKLM, e a leitura e
    // liberada a usuario comum (BUILTIN\Usuarios tem ReadKey), entao o app
    // nao precisa de privilegio nenhum.
    static string LerAgentId()
    {
        return LerValor(RegistryHive.LocalMachine, @"SOFTWARE\TacticalRMM", "AgentID");
    }

    // Permite trocar a URL sem recompilar - recompilar muda o hash do .exe e
    // zera a reputacao dele no antivirus. HKCU primeiro, para que um teste por
    // usuario possa apontar a outro ambiente sem mexer na config da maquina.
    static string LerUrlBase()
    {
        var url = LerValor(RegistryHive.CurrentUser, CAMINHO_CFG, "Url");
        if (url == null) url = LerValor(RegistryHive.LocalMachine, CAMINHO_CFG, "Url");
        return url == null ? URL_PADRAO : url;
    }

    static void Abrir()
    {
        var id = LerAgentId();
        var url = LerUrlBase();
        // novo=1: quem clica no icone quer abrir chamado, entao a pagina ja
        // sobe com o modal aberto em vez de parar na lista.
        var query = "novo=1";
        // Sem AgentID (maquina sem agente): abre assim mesmo - a pagina cai no
        // fallback de escolha manual em vez de travar o usuario.
        if (id != null) query += "&agent=" + Uri.EscapeDataString(id);
        url += (url.Contains("?") ? "&" : "?") + query;

        try
        {
            var psi = new ProcessStartInfo(url);
            psi.UseShellExecute = true;
            Process.Start(psi);
        }
        catch (Exception ex)
        {
            MessageBox.Show("Nao foi possivel abrir o navegador.\n\n" + ex.Message,
                "Abrir chamado", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    // O PNG vai embutido no .exe; redimensionar para o tamanho real da bandeja
    // evita o borrao de deixar o Windows encolher a imagem sozinho.
    static Icon CarregarIcone()
    {
        try
        {
            var asm = Assembly.GetExecutingAssembly();
            using (var fluxo = asm.GetManifestResourceStream("logo.png"))
            using (var original = new Bitmap(fluxo))
            using (var pequeno = new Bitmap(original, SystemInformation.SmallIconSize))
            {
                return Icon.FromHandle(pequeno.GetHicon());
            }
        }
        catch { return SystemIcons.Application; }
    }
}
'@

$cs = Join-Path $tmp 'Program.cs'
Set-Content -Path $cs -Value $fonte -Encoding UTF8

# ---------- Compilar ----------
$exeTmp = Join-Path $tmp "$NOME_APP.exe"
$argumentos = @(
  '/nologo', '/target:winexe', '/optimize+',
  "/out:$exeTmp",
  "/win32icon:$ico",
  "/resource:$png,logo.png",
  '/r:System.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll',
  $cs
)
# 2>&1 num executavel nativo embrulha cada linha de stderr num ErrorRecord e,
# com preferencia 'Stop', um simples aviso do compilador abortaria a instalacao.
# Baixamos a guarda so aqui, para capturar a saida sem esse risco.
$ErrorActionPreference = 'Continue'
$saida = & $csc $argumentos 2>&1
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $exeTmp)) {
  Write-Output "ERRO na compilacao:"
  $saida | ForEach-Object { Write-Output "  $_" }
  exit 1
}

Copy-Item $exeTmp $exe -Force
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Output "Compilado: $exe ($((Get-Item $exe).Length) bytes)"

# ---------- Registro: URL, versao e autostart ----------
$raiz = Get-Raiz
$cfg = $raiz.CreateSubKey('SOFTWARE\Intecs\Chamados')
$cfg.SetValue('Url', $URL_BASE)
$cfg.SetValue('Versao', $VERSAO)
$cfg.Close()
Write-Output "URL configurada: $URL_BASE"

# No escopo de maquina o Run fica em HKLM e vale para todo mundo que logar.
# No escopo de usuario vai para HKCU e vale so para quem instalou.
$run = $raiz.CreateSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Run')
$run.SetValue('IntecsAbrirChamado', '"' + $exe + '"')
$run.Close()
Write-Output "Autostart registrado."

Write-Output ""
Write-Output "Iniciando o app sem esperar o proximo logon..."
if (Start-AppAgora $exe) {
  Write-Output "OK. O icone ja esta na bandeja - clique nele para abrir o chamado."
} else {
  # Nao subir agora nao e falha de instalacao: o autostart ja esta no lugar.
  Write-Output "O app nao subiu agora, mas a instalacao esta completa -"
  Write-Output "ele entra sozinho no proximo logon. Para forcar: $exe"
}
exit 0
