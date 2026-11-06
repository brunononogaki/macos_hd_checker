# Como funciona

## O inventário

Na primeira verificação, o app calcula o **SHA-256** de cada arquivo e guarda num banco SQLite local: caminho, tamanho, data de modificação e hash. Esse inventário é a "impressão digital" do seu acervo.

## O que acontece a cada verificação

| Situação | O que o app conclui |
|---|---|
| Mesmo tamanho e mesma data, **hash diferente** | **Corrupção silenciosa.** Alerta vermelho. |
| Tamanho ou data mudaram | Edição legítima. Só atualiza o inventário. |
| Arquivo novo | Valida a estrutura e registra o hash. Pega arquivos que já nasceram quebrados. |
| Arquivo sumiu | Aviso. Renomear ou mover **não** gera alerta: o app reconhece o arquivo pelo hash. |
| Erro de leitura (EIO) | Alerta. É o sinal clássico de HD com setores ruins. |

## Validação de estrutura

Para arquivos novos, o app confere se o arquivo "faz sentido" para o formato:

- **JPEG:** começa e termina corretamente (inclui fotos de celular com dados extras no final, como mapas de profundidade)
- **PNG, TIFF, RAW (DNG/CR2/ARW):** cabeçalhos e tamanhos coerentes
- **MP4/MOV/CR3:** presença do índice (`moov`) e caixas completas
- **WAV:** cabeçalho e tamanho dos dados

Isso acusa arquivos de 0 bytes, truncados, com final preenchido por zeros e vídeos sem índice. Veja os limites em [Limitações](limitacoes.md).

## Verificação completa × agendada × das mudanças

=== "Completa"

    Lê **100%** do disco, sem limite de horário, e não depende de agendamento configurado. É para a primeira catalogação ou uma conferência geral. Se for interrompida, dá para continuar de onde parou.

=== "Agendada (rodízio)"

    Cada execução re-verifica uma **fatia** do disco (padrão 12,5%), começando pelos arquivos verificados há mais tempo, e pode ter um limite de duração. Assim, 8 TB não precisam ser relidos toda semana, e o disco todo é coberto ao longo de várias execuções.

=== "Das mudanças"

    Lê apenas arquivos novos ou alterados (e os que já têm erro aberto). Use logo depois de copiar fotos para o disco.

## Vários discos ao mesmo tempo

Cada disco é verificado por um processo separado, então vários discos podem rodar em paralelo. Em cada disco só roda **uma** verificação por vez: se uma segunda for iniciada (por exemplo, o agendamento coincide com uma execução manual), ela é pulada com um aviso. Execuções que morrem no meio (queda de energia, app encerrado à força) são detectadas e marcadas como interrompidas.

## Só leitura

O app **nunca escreve nos seus discos**. O único efeito é a leitura dos arquivos e, nas ações de saúde que você aciona (checar o sistema de arquivos, ejetar), os comandos do próprio macOS.
