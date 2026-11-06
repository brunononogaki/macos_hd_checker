# Histórico de versões

## 1.1.0

- Interface: aba **Agendamentos** (antes "Jobs"), versão do app no rodapé, botões do card de disco reorganizados e alinhados.
- **Verificação completa** manual: lê 100% do disco, sem limite de horário e sem precisar de agendamento configurado.
- **Continuar de onde parou** para verificações completas interrompidas.
- Execuções agendadas em segundo plano aparecem no banner e no título da janela.
- **Limpar alertas de "Arquivo sumiu" em lote** por pasta, em Relatórios.
- Discos desconectados com inventário continuam na lista mesmo sem agendamento; o filtro de Relatórios os inclui.
- Menos falsos positivos: fotos de celular com dados extras no final do JPEG, arquivos apagados com erro aberto e a pasta `.bzvol` (Backblaze) ignorada.
- Removidos: comparação de cópia (origem × destino), backup do inventário e o ajuste de leituras simultâneas (fixo em 2).
- Correção: estilos inline bloqueados pela política de conteúdo (espaçamentos que não mudavam).

## 1.0.0

- Primeira versão: inventário com SHA-256, detecção de corrupção silenciosa, validação de estrutura, verificação agendada em rodízio, relatórios, e-mail de aviso, checagem do sistema de arquivos e ejeção segura.
