Atue como um desenvolvedor Full-Stack especialista em Google Apps Script. Preciso criar um Web App que servirá como interface (front-end) para inserir dados em uma planilha do Google Sheets. O objetivo da aplicação é facilitar o preenchimento de uma revalidação de inventário de equipamentos, evitando que o usuário edite a planilha diretamente.

A estrutura da planilha possui as seguintes colunas (exatamente nesta ordem, da coluna A até a I):

UNIDADE

STATUS

SETOR

USUARIO

N/S (Número de Série)

PAT_MSA - ANTIGO

PAT_MSA - NOVO

EQUIPAMENTO

OBS (Observações)

Requisitos Técnicos e de Interface:

Front-end (Index.html): Crie um formulário HTML responsivo e limpo. Utilize uma biblioteca CSS como o Bootstrap (via CDN) para dar um visual profissional e moderno sem muito esforço.

Tipos de Campos: >   - Campos de texto padrão para USUARIO, N/S, PAT_MSA - ANTIGO, PAT_MSA - NOVO e OBS.

Dropdowns (<select>) para STATUS (ex: Ativo, Inativo, Em Manutenção, Descarte) e EQUIPAMENTO (ex: Desktop, Monitor, Câmera, Switch, DVR, Impressora).

Interatividade: O formulário deve ter validação básica (impedir envio com campos cruciais vazios). Ao enviar, deve exibir uma mensagem de sucesso na tela e limpar o formulário, sem recarregar a página.

Back-end (Code.gs): Escreva a função doGet() para renderizar a página e a função para processar os dados recebidos do front-end e dar um appendRow na aba ativa da planilha.

Por favor, me forneça os dois arquivos de código separados e um breve passo a passo de como fazer o deploy (Nova Implantação) no Apps Script.