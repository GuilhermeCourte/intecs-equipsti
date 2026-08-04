@echo off
REM ============================================================
REM  Abre o cockpit na TV com o som JA ativo.
REM
REM  Por que este arquivo existe: o Chrome bloqueia audio em pagina que
REM  ninguem tocou (politica de autoplay). Numa tela de parede nao ha quem
REM  clique, entao o painel abriria mudo e com o botao de som em vermelho a
REM  cada recarregamento. Nao ha como o codigo da pagina contornar isso — a
REM  liberacao tem que vir na linha de comando do navegador.
REM
REM  --autoplay-policy=no-user-gesture-required  libera o som sem clique
REM  --kiosk                                    tela cheia, sem barra nem abas
REM  --user-data-dir                            perfil separado, para nao mexer
REM                                             no Chrome de uso normal (e para
REM                                             a permissao de notificacao ficar
REM                                             guardada so aqui)
REM
REM  Ajuste a URL abaixo para o endereco do painel.
REM ============================================================

set "URL=http://localhost:3000/cockpit"
set "PERFIL=%LOCALAPPDATA%\GestaoTI\cockpit-chrome"

set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" (
  echo Chrome nao encontrado. Edite a variavel CHROME neste arquivo.
  pause
  exit /b 1
)

start "" "%CHROME%" ^
  --autoplay-policy=no-user-gesture-required ^
  --kiosk ^
  --user-data-dir="%PERFIL%" ^
  --disable-session-crashed-bubble ^
  --noerrdialogs ^
  "%URL%"
