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
$VERSAO   = '1.0.1'
$URL_BASE = 'https://gestaoti.intecsbr.org/chamados'
$NOME_APP = 'AbrirChamado'
# ----------------------------------

# SYSTEM (como o RMM roda) tambem carrega o grupo Administradores no token,
# entao esta checagem cobre os dois casos de instalacao para a maquina toda.
$ehAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($ehAdmin) {
  # Em processo de 32 bits $env:ProgramFiles apontaria para "Program Files (x86)".
  $programFiles = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
  $destino = Join-Path $programFiles 'Intecs\AbrirChamado'
  $hive    = [Microsoft.Win32.RegistryHive]::LocalMachine
  $escopo  = 'MAQUINA (todos os usuarios)'
} else {
  $destino = Join-Path $env:LOCALAPPDATA 'Intecs\AbrirChamado'
  $hive    = [Microsoft.Win32.RegistryHive]::CurrentUser
  $escopo  = 'USUARIO ATUAL (sem privilegio de administrador)'
}

$exe = Join-Path $destino "$NOME_APP.exe"

function Get-Raiz {
  # Registry64 evita cair em Wow6432Node se o PowerShell for de 32 bits.
  [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, [Microsoft.Win32.RegistryView]::Registry64)
}

Write-Output "Escopo: $escopo"

# ---------- Ja esta instalado nesta versao? ----------
try {
  $raiz = Get-Raiz
  $k = $raiz.OpenSubKey('SOFTWARE\Intecs\Chamados')
  if ($k) {
    $instalada = $k.GetValue('Versao')
    $k.Close()
    if ($instalada -eq $VERSAO -and (Test-Path $exe)) {
      Write-Output "Ja instalado na versao $VERSAO. Nada a fazer."
      # Recompilar a toa geraria um binario com hash novo a cada execucao da
      # policy, zerando a reputacao dele no antivirus toda vez.
      exit 0
    }
  }
} catch { }

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

# ---------- Encerrar instancia anterior (senao o .exe fica travado) ----------
Get-Process -Name $NOME_APP -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Output "Encerrando instancia anterior (pid $($_.Id))"
  try { $_.Kill(); $_.WaitForExit(5000) } catch { }
}

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

            var menu = new ContextMenuStrip();
            menu.Items.Add("Abrir chamado", null, delegate { Abrir(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Sair", null, delegate
            {
                icone.Visible = false;
                Application.Exit();
            });

            icone = new NotifyIcon();
            icone.Icon = CarregarIcone();
            icone.Text = "Abrir chamado - TI Intecs";
            icone.ContextMenuStrip = menu;
            icone.Visible = true;
            icone.MouseClick += delegate (object s, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Left) Abrir();
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
        // Sem AgentID (maquina sem agente): abre assim mesmo - a pagina cai no
        // fallback de escolha manual em vez de travar o usuario.
        if (id != null) url += (url.Contains("?") ? "&" : "?") + "agent=" + Uri.EscapeDataString(id);

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
$saida = & $csc $argumentos 2>&1
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
if ($ehAdmin) {
  Write-Output "OK. O icone aparece na bandeja no PROXIMO LOGON de cada usuario."
  Write-Output "Para ver agora sem deslogar, execute na sessao do usuario:"
  Write-Output "  $exe"
} else {
  # Sem privilegio ja estamos na sessao do usuario, entao da para subir agora.
  Write-Output "Iniciando agora nesta sessao..."
  Start-Process $exe
  Start-Sleep -Seconds 2
  if (Get-Process -Name $NOME_APP -ErrorAction SilentlyContinue) {
    Write-Output "OK. O icone ja esta na bandeja (clique nele para abrir o chamado)."
  } else {
    Write-Output "AVISO: o app nao subiu. Tente executar manualmente: $exe"
  }
}
exit 0
