# Primeiros passos

## 1. Conecte o disco e abra o app

Abra o HD Checker com o HD conectado. A tela **Discos** lista todos os volumes montados, com o espaço usado e o estado de cada um.

## 2. Faça a primeira catalogação

No card do disco, clique em **Verificação completa**. O app lê 100% dos arquivos, calcula o hash de cada um e valida a estrutura dos arquivos novos.

!!! warning "A primeira vez é demorada"
    Calcular o hash de 8 TB leva **cerca de 15 horas**, dependendo do HD. Você pode fechar a janela: no macOS as verificações continuam em segundo plano. Só **Sair** (⌘Q) as encerra. Se algo interromper (disco desconectado, parada manual), use **Continuar de onde parou**.

## 3. Veja o resultado

Ao terminar, o card mostra "Tudo certo" ou o número de problemas. Os detalhes ficam em **Relatórios**. Se aparecer um alerta vermelho, [restaure o arquivo do seu backup](uso/relatorios.md#o-que-fazer-com-um-alerta).

## 4. Agende as próximas verificações

Em **Agendamentos**, ligue **Executar automaticamente** e escolha a frequência. Cada execução agendada re-verifica uma fatia do disco (padrão 12,5%), então o disco todo é coberto em 8 execuções. Veja [Agendamentos](uso/agendamentos.md).

## 5. Receba avisos por e-mail (opcional)

Em **Configurações**, preencha o servidor SMTP e clique em **Salvar e enviar teste**. Com Gmail, use uma *senha de app*. Veja [Configurações](uso/configuracoes.md).

## Rotina recomendada

| Quando | O que fazer |
|---|---|
| Depois de copiar fotos para o disco | **Verificação das mudanças** (rápida: lê só o que é novo ou alterado) |
| Todo mês ou semana | Deixar o agendamento rodar sozinho |
| Depois de desligar o Mac sem ejetar o disco | **Checar sistema de arquivos** (principalmente em exFAT, que não tem journal) |
| Antes de apagar uma pasta de origem | Confirme que o disco de destino está sem alertas |
