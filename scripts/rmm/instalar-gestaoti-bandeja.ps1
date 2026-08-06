# ============================================================
#  Tactical RMM - instala o "Gestao TI" na bandeja do sistema.
#
#  POR QUE ISSO EXISTE
#  Atalho sempre a mao para o Gestao TI, sem depender de aba aberta nem de
#  achar o favorito.
#
#  ELE NAO RECEBE NOTIFICACAO - e nem precisa. Quem entrega notificacao com o
#  navegador fechado e o Web Push que o sistema ja tem: a inscricao fica
#  gravada em EQUIPSTI_push_subscriptions e o Chrome/Edge mantem um processo
#  em segundo plano que mostra o toast do Windows mesmo sem janela aberta.
#  Essa inscricao nao expira - diferente do JWT, que vale 12h.
#
#  Por isso o app nao pede login: quem sabe se ha sessao ativa e o navegador,
#  nao o icone da bandeja.
#
#  CLICANDO: se o PWA do Gestao TI estiver instalado, abre o PWA (janela
#  propria, e o processo de background que entrega o push); se nao estiver,
#  abre a URL no navegador padrao.
#
#  CONVIVE COM O "AbrirChamado", que e outro app, com outro icone e outra
#  finalidade. Todos os identificadores aqui sao proprios (pasta, chave Run,
#  chave de configuracao, mutex) - trocar qualquer um por engano faz os dois
#  se atropelarem.
#
#  AUTOCONTIDO: compila na propria maquina com o csc.exe que ja vem no
#  Windows. Nao precisa transferir binario nem instalar .NET.
#
#  DOIS MODOS, escolhidos automaticamente:
#    - Com privilegio (SYSTEM pelo RMM, ou PowerShell como administrador):
#      instala em Program Files e vale para TODOS os usuarios da maquina.
#    - Sem privilegio (teste manual): instala no perfil do usuario atual.
#
#  Pode rodar quantas vezes quiser - so recompila quando a versao muda.
#
#  ARQUIVO EM ASCII PURO de proposito: acento sem BOM vira mojibake no
#  PowerShell 5.1 e no copiar/colar para o editor de scripts do RMM.
# ============================================================

$ErrorActionPreference = 'Stop'

# ---------- Configuracao ----------
$VERSAO   = '1.1.1'
$URL_BASE = 'https://gestaoti.intecsbr.org'
$NOME_APP = 'GestaoTI'
# ----------------------------------

# SYSTEM (como o RMM roda) tambem carrega o grupo Administradores no token,
# entao esta checagem cobre os dois casos de instalacao para a maquina toda.
$ehAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# Em processo de 32 bits $env:ProgramFiles apontaria para "Program Files (x86)".
$programFiles  = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
$pastaMaquina  = Join-Path $programFiles 'Intecs\GestaoTI'
$pastaUsuario  = Join-Path $env:LOCALAPPDATA 'Intecs\GestaoTI'

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
    $k = (Get-Raiz $h).OpenSubKey('SOFTWARE\Intecs\GestaoTI')
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
    if ($run.GetValue('IntecsGestaoTI')) { $run.DeleteValue('IntecsGestaoTI') }
    $run.Close()
  }
  $intecs = $raiz.OpenSubKey('SOFTWARE\Intecs', $true)
  if ($intecs) {
    # DeleteSubKeyTree('GestaoTI') - NUNCA 'Chamados', que e do AbrirChamado.
    if ($intecs.OpenSubKey('GestaoTI')) { $intecs.DeleteSubKeyTree('GestaoTI') }
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
# sessao da pessoa e uma tarefa agendada marcada como interativa: o Windows a
# executa dentro da sessao dela. Criamos, disparamos e apagamos.
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
    $tarefa = 'IntecsGestaoTIPrimeiraExecucao'
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
  # Instalado e correto, mas fora do ar (fechado pelo gerenciador de tarefas,
  # ou logou antes da instalacao): sobe de novo em vez de esperar o proximo
  # logon. E o que torna a policy autocorretiva.
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
$tmp = Join-Path $env:TEMP 'intecs-gestaoti-build'
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
# Sai de public/favicon_intecs.png reduzido - a MESMA origem do AbrirChamado,
# que troca so o fundo pelo gradiente. Por isso os dois ficam com a marca do
# mesmo tamanho na bandeja (23x26 px dentro do quadro de 32), e o que distingue
# um do outro e o fundo: cinza escuro aqui, gradiente la.
#
# Nao usar public/icons/icon-192.png: ele e o icone do PWA, com margem extra
# para a zona segura dos icones adaptativos, e a marca sai 30% menor.
$logoB64 = @(
'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'
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
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

static class Program
{
    const string URL_PADRAO = "https://gestaoti.intecsbr.org";
    const string CAMINHO_CFG = @"SOFTWARE\Intecs\GestaoTI";
    // Nome do PWA no menu Iniciar. Sai do "name" de public/manifest.json.
    const string NOME_PWA = "Gestao TI";

    static NotifyIcon icone;
    static DateTime ultimoClique = DateTime.MinValue;

    [STAThread]
    static void Main()
    {
        bool primeiro;
        // Sem isso, cada logon acumularia um icone na bandeja. Tambem impede
        // dois icones quando existe instalacao por maquina e por usuario ao
        // mesmo tempo.
        using (new Mutex(true, "Intecs.GestaoTI.InstanciaUnica", out primeiro))
        {
            if (!primeiro) return;

            Application.EnableVisualStyles();

            icone = new NotifyIcon();
            icone.Icon = CarregarIcone();
            icone.Text = "Gestao TI";
            icone.Visible = true;
            // Sem menu de contexto de proposito: o icone serve para uma coisa
            // so, entao qualquer clique - esquerdo, direito ou do meio - abre o
            // Gestao TI. Nao ha "Sair" para o usuario nao desligar sem querer;
            // quem remove e o desinstalador, pelo RMM.
            icone.MouseClick += delegate
            {
                // Clicar duas vezes e habito comum na bandeja; sem esta guarda
                // abririam duas janelas.
                if ((DateTime.Now - ultimoClique).TotalMilliseconds < 800) return;
                ultimoClique = DateTime.Now;
                Abrir();
            };

            Application.Run();
        }
    }

    static void Abrir()
    {
        // Procurado no clique, e nao na instalacao: quem instalar o PWA depois
        // passa a abrir nele sem precisar reinstalar nada.
        string atalho = AcharAtalhoPwa();
        // Atalho orfao (PWA desinstalado deixando o .lnk para tras) nao pode
        // travar o usuario - por isso a URL e sempre a ultima tentativa.
        if (atalho != null && Iniciar(atalho, false)) return;
        Iniciar(UrlBase(), true);
    }

    static bool Iniciar(string alvo, bool avisar)
    {
        try
        {
            var psi = new ProcessStartInfo(alvo);
            psi.UseShellExecute = true;
            Process.Start(psi);
            return true;
        }
        catch (Exception ex)
        {
            if (avisar)
            {
                MessageBox.Show("Nao foi possivel abrir o Gestao TI.\n\n" + ex.Message,
                    "Gestao TI", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            return false;
        }
    }

    // Chrome e Edge criam um .lnk no menu Iniciar quando o PWA e instalado -
    // ora solto em Programas, ora dentro de "Chrome Apps", conforme a versao.
    // Procurar o atalho cobre os dois navegadores e nao depende do formato do
    // --app-id, que muda com a versao e com o perfil.
    static string AcharAtalhoPwa()
    {
        string[] raizes = {
            Environment.GetFolderPath(Environment.SpecialFolder.Programs),
            Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms)
        };
        // Quando o PWA esta marcado para abrir no logon, o navegador cria um
        // SEGUNDO atalho na pasta Inicializar, com o argumento
        // --app-run-on-os-login-mode. Ele nao serve aqui: some no dia em que a
        // pessoa desliga o auto-inicio, enquanto o lancador de verdade fica.
        string[] inicializar = {
            Environment.GetFolderPath(Environment.SpecialFolder.Startup),
            Environment.GetFolderPath(Environment.SpecialFolder.CommonStartup)
        };

        string achado = null;
        DateTime maisNovo = DateTime.MinValue;
        foreach (var raiz in raizes)
        {
            if (string.IsNullOrEmpty(raiz) || !Directory.Exists(raiz)) continue;
            string[] arquivos;
            try { arquivos = Directory.GetFiles(raiz, "*.lnk", SearchOption.AllDirectories); }
            catch { continue; }
            foreach (var arquivo in arquivos)
            {
                if (!EhAtalhoDoPwa(Path.GetFileNameWithoutExtension(arquivo))) continue;
                if (EstaEm(arquivo, inicializar)) continue;
                DateTime quando;
                try { quando = File.GetLastWriteTimeUtc(arquivo); } catch { continue; }
                // Havendo mais de um (dois navegadores, ou dois perfis), o mais
                // recente e o que a pessoa instalou por ultimo.
                if (quando > maisNovo) { maisNovo = quando; achado = arquivo; }
            }
        }
        return achado;
    }

    // Comparacao pelo caminho real, e nao pelo nome "Startup": a pasta muda de
    // nome conforme o idioma do Windows.
    static bool EstaEm(string arquivo, string[] pastas)
    {
        string dir;
        try { dir = Path.GetDirectoryName(arquivo); } catch { return false; }
        foreach (var pasta in pastas)
        {
            if (string.IsNullOrEmpty(pasta)) continue;
            if (string.Equals(dir.TrimEnd('\\'), pasta.TrimEnd('\\'),
                    StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    // O manifest chama o app de "Gestao TI" com til no "a"; este arquivo e
    // ASCII puro, entao o acento vai escapado e a comparacao o remove - assim
    // nao dependemos de como cada navegador gravou o nome do arquivo.
    //
    // StartsWith, e nao igualdade: algumas versoes do Edge acrescentam o nome
    // do perfil ao atalho ("Gestao TI (Perfil 2)").
    static bool EhAtalhoDoPwa(string nome)
    {
        if (string.IsNullOrEmpty(nome)) return false;
        string limpo = nome.Replace("\u00e3", "a").Replace("\u00c3", "A").Trim();
        return limpo.StartsWith(NOME_PWA, StringComparison.OrdinalIgnoreCase);
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

    // Permite trocar a URL sem recompilar - recompilar muda o hash do .exe e
    // zera a reputacao dele no antivirus. HKCU primeiro, para que um teste por
    // usuario possa apontar a outro ambiente sem mexer na config da maquina.
    static string UrlBase()
    {
        var url = LerValor(RegistryHive.CurrentUser, CAMINHO_CFG, "Url");
        if (url == null) url = LerValor(RegistryHive.LocalMachine, CAMINHO_CFG, "Url");
        return url == null ? URL_PADRAO : url;
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
$cfg = $raiz.CreateSubKey('SOFTWARE\Intecs\GestaoTI')
$cfg.SetValue('Url', $URL_BASE)
$cfg.SetValue('Versao', $VERSAO)
$cfg.Close()
Write-Output "URL configurada: $URL_BASE"

# No escopo de maquina o Run fica em HKLM e vale para todo mundo que logar.
# No escopo de usuario vai para HKCU e vale so para quem instalou.
$run = $raiz.CreateSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Run')
$run.SetValue('IntecsGestaoTI', '"' + $exe + '"')
$run.Close()
Write-Output "Autostart registrado."

Write-Output ""
Write-Output "Iniciando o app sem esperar o proximo logon..."
if (Start-AppAgora $exe) {
  Write-Output "OK. O icone ja esta na bandeja - clique nele para abrir o Gestao TI."
} else {
  # Nao subir agora nao e falha de instalacao: o autostart ja esta no lugar.
  Write-Output "O app nao subiu agora, mas a instalacao esta completa -"
  Write-Output "ele entra sozinho no proximo logon. Para forcar: $exe"
}
exit 0
