# Perguntas frequentes

??? question "O app altera ou apaga arquivos nos meus discos?"
    Não. Ele só lê. As ações de saúde (checar o sistema de arquivos e ejetar) usam os comandos do próprio macOS.

??? question "Por que a primeira verificação demora tanto?"
    Cada byte precisa ser lido para calcular o hash. Em um HD externo mecânico, 8 TB levam cerca de 15 horas. Depois, as verificações são muito mais rápidas, porque lêem só uma fatia ou só o que mudou.

??? question "Posso fechar a janela durante uma verificação?"
    Sim. No macOS, fechar a janela **não** interrompe as verificações. Só **Sair** (⌘Q) as encerra. O que já foi lido fica salvo e a próxima execução continua.

??? question "Dá para parar e continuar depois?"
    Sim. Se a verificação completa for interrompida, o card do disco mostra **Continuar de onde parou**.

??? question "Apaguei ou movi pastas de propósito. Como tiro os alertas de arquivo sumido?"
    Em *Relatórios*, filtre por **Arquivo sumiu**, informe as pastas e use **Foi apagado de propósito — todos**. Veja [Relatórios](uso/relatorios.md#limpar-arquivo-sumiu-em-lote).

??? question "Renomear ou mover arquivos gera alerta?"
    Não. O app reconhece o arquivo pelo hash e pelo tamanho.

??? question "Apareceu um alerta de corrupção. E agora?"
    Restaure a versão anterior do arquivo a partir do backup, antes que ele perca a versão boa, e rode uma verificação: o alerta fecha sozinho. Se você mudou o arquivo de propósito, use **Aceitar versão atual**.

??? question "Por que o macOS não deixa ejetar o disco?"
    Algum programa está usando o disco (muito comum: a visualização rápida do Finder, serviços de backup ou o Spotlight). O botão **Ejetar** mostra quem é e pode pedir que o programa encerre.

??? question "Funciona com SSDs e discos internos?"
    Funciona com qualquer volume que o macOS monte. O ajuste de leituras simultâneas é fixo (2), pensado para HDs externos mecânicos.

??? question "Funciona com Windows ou Linux?"
    Não. O app é só para macOS.

??? question "O app envia meus dados para algum servidor?"
    Não. Veja [Onde ficam os dados](dados.md#privacidade).
