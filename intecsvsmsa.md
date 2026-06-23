# Especificação de Campos do Sistema (Controle de Chamados MSA / INTECS)

## 1. Informações do Chamado MSA

* **DATA SOLICITACAO**
* **Tipo:** Data
* **Descrição:** Data da abertura do chamado na MSA.


* **NUMERO CHAMADO MSA**
* **Tipo:** Número / Texto curto
* **Descrição:** Número do chamado gerado na plataforma da MSA.


* **PROBLEMA**
* **Tipo:** Texto longo (Área de texto)
* **Descrição:** Campo contendo a descrição do problema relatado no chamado da MSA.


* **STATUS MSA**
* **Tipo:** Campo Calculado / Automático (Lista: *Aberto*, *Em Andamento*, *Finalizado*)
* **Regra de Negócio:** * `Aberto`: Quando a **DATA RETIRADA EQUIP** não estiver preenchida.
* `Em Andamento`: Quando a **DATA RETIRADA EQUIP** estiver preenchida (e a data de entrega estiver vazia).
* `Finalizado`: Quando a **DATA ENTREGA EQUIP** estiver preenchida.





## 2. Dados da Unidade e Vínculos

* **UNIDADE**
* **Tipo:** Seleção (Combobox / Dropdown)
* **Descrição:** Unidade do chamado. Deve vincular e puxar as opções do cadastro geral de unidades do sistema para o chamado MSA. ( nesse caso acho interessante vincularmos novamente o cadastro da unidade nas opcoes a unidade do chamado msa)



## 3. Controle Interno INTECS & GLPI

* **GLPI**
* **Tipo:** Numérico
* **Descrição:** Campo de número para informar o ID do chamado correspondente no sistema GLPI.


* **STATUS INTECS**
* **Tipo:** Seleção (Lista: *Aberto*, *Em Andamento*, *Finalizado*)
* **Descrição:** Status de controle interno da equipe INTECS.




## 4. Dados do Equipamento Original (Vindo do Patrimônio)

* **PATRIMONIO MSA**
* **Tipo:** Texto curto / Alfanumérico
* **Descrição:** Número do patrimônio do equipamento informado no chamado da MSA.


* **Nº SERIE**
* **Tipo:** Texto curto
* **Descrição:** Número de série do equipamento informado no chamado MSA.


* **PONTO DE INSTALAÇÃO**
* **Tipo:** Automático (Lookup / Auto-preechimento)
* **Descrição:** Busca automaticamente o setor cadastrado vinculado ao número do Patrimônio e ns informado.


* **DESCRIÇÃO EQUIP**
* **Tipo:** Automático (Lookup / Auto-preechimento)
* **Descrição:** Busca automaticamente o nome/descrição do equipamento cadastrado vinculado ao número do Patrimônio e ns informado.



## 5. Controle de Movimentação de Hardware (Logística)

* **DATA RETIRADA EQUIP**
* **Tipo:** Data (Preenchimento manual)
* **Descrição:** Campo aberto para informar manualmente a data em que o equipamento foi retirado.


* **DATA ENTREGA EQUIP**
* **Tipo:** Data (Preenchimento manual)
* **Descrição:** Campo aberto para informar manualmente a data em que o equipamento foi devolvido/entregue.



## 6. Controle de Backup (Empréstimos INTECS)

* **PATRIMONIO BKP INTECS**
* **Tipo:** Seleção / Pesquisa
* **Descrição:** Campo para selecionar o patrimônio do equipamento reserva (backup) que foi emprestado para esta unidade. (isso abre um modal pra ele selecionar que nem a tela do emprestimo)


* **BKP UNIDADE**
* **Tipo:** Texto / Consulta
* **Descrição:** Identifica a unidade de origem/pertencimento deste patrimônio de backup selecionado.



## 7. Informações Adicionais

* **OBSERVAÇÃO**
* **Tipo:** Texto livre (Área de texto)
* **Descrição:** Campo livre para anotações gerais sobre o andamento ou histórico do chamado.