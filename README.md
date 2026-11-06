# HD Checker

> App de menu/desktop para macOS (Electron) que detecta bit rot em HDs externos (exFAT/APFS) e avisa antes de o backup perder a versão boa.

Requisitos: macOS, Node ≥ 22.13. Testes: `npm test`. App empacotado: `npm run package`.

Detecta **corrupção silenciosa (bit rot)** nos seus HDs de fotos *antes* que o backup da Backblaze
(retenção de 1 ano) sobrescreva a última versão boa do arquivo.

## Como funciona

1. **Inventário:** o app calcula o SHA-256 de cada arquivo e guarda num banco SQLite
   (caminho, tamanho, data, hash).
2. **Comparação:** nas execuções seguintes ele compara:
   - mesmo tamanho e mesma data, **hash diferente** → corrupção silenciosa (alerta vermelho);
   - tamanho/data mudou → edição legítima; só atualiza o inventário;
   - arquivo novo → valida a estrutura (JPEG, PNG, DNG/CR2/ARW/TIFF, MP4/MOV/CR3, WAV) e registra o hash.
     Pega arquivos que já nasceram quebrados: 0 bytes, truncados, vídeo sem índice `moov`...;
   - arquivo sumiu → aviso (renomear/mover **não** gera alerta: é reconhecido pelo hash);
   - erro de leitura (EIO) → alerta: sinal clássico de HD com setores ruins.
3. **Rodízio (execuções agendadas):** cada execução agendada re-verifica uma *fatia* do disco (padrão 12,5% → disco todo em 8 execuções),
   começando pelos arquivos verificados há mais tempo, e pode ter limite de duração. Assim 8 TB não precisam ser relidos toda semana.
   A fatia e o limite valem **só para o agendamento**; as verificações manuais (botões da aba Discos) não dependem de job configurado.
4. **Aviso:** e-mail quando houver problema + relatório no app. Quando você restaura o arquivo pela Backblaze,
   a próxima execução fecha o alerta sozinha.

O app **só lê** os discos. Nunca altera nem apaga nada neles.

## Instalação (macOS)

```bash
git clone https://github.com/brunononogaki/macos_hd_checker.git
cd macos_hd_checker
npm install
npm start
```

Não há módulos nativos para compilar: o banco usa o `node:sqlite` embutido (Electron ≥ 37).
Um `ExperimentalWarning` no console é normal.

### Primeiros passos
1. **Discos** → "Monitorar este disco" no Fotos (e no Fotos_02).
2. **Jobs** → ajuste frequência/horário, marque "Executar automaticamente" e salve.
3. **Configurações** → SMTP (Gmail: use uma *senha de app*) e a **pasta de backup do inventário**
   (escolha uma pasta que a Backblaze já cubra) → "Salvar e enviar teste".
4. **Discos** → "Verificação completa" para a primeira catalogação.

### A primeira execução é longa
Calcular o hash de 8 TB leva **cerca de 15 horas** (depende do HD). Use o *limite de duração* do job
(ex.: 8 h): ao atingir o limite a execução termina com segurança e **continua de onde parou** na próxima.
Dica: deixe o job diário até o inventário completar e depois mude para semanal.

### Permissões do macOS
- Execuções agendadas rodam pelo `launchd` usando o binário do Electron. Na primeira vez o macOS pode pedir
  acesso a "Volumes removíveis"; se a execução agendada não enxergar o disco, dê **Acesso total ao disco**
  ao Electron em *Ajustes do Sistema → Privacidade e Segurança*.
- O Mac precisa estar ligado (ou dormindo: o `launchd` roda ao acordar) e com o HD conectado no horário.
  Se o disco não estiver conectado, a execução é pulada e registrada.
- O agendamento usa `caffeinate -i` para o Mac não dormir no meio da verificação.

## Onde ficam os dados
| O quê | Onde |
|---|---|
| Configuração | `~/Library/Application Support/hd_checker/config.json` |
| Inventário (SQLite) | `~/Library/Application Support/hd_checker/inventory.db` |
| Logs das execuções agendadas | `~/Library/Application Support/hd_checker/logs/` |
| Senha SMTP | Keychain do macOS (serviço `hd_checker_smtp`) |
| Agendamentos | `~/Library/LaunchAgents/com.hdchecker.job.<id>.plist` |

O banco **não** fica em `Documents` de propósito: o iCloud Drive pode corromper um SQLite em uso.
Em vez disso, após cada execução o app copia o inventário (`VACUUM INTO`) para a pasta de backup
configurada, que a Backblaze protege.

## Abrir como aplicativo (ícone no Dock)

```bash
cd /Users/bruno.nonogaki/Documents/@DEV/@PROJECTS/hd_checker
npm install
npm run package          # gera dist/HD Checker.app
```

Arraste `dist/HD Checker.app` para a pasta Aplicativos. Na primeira vez, clique com o botão direito → Abrir (o app não é assinado pela Apple, só com assinatura local). Como a identidade do app muda, o macOS pede de novo a permissão de "Volumes removíveis"; aceite. Se mover o app ou gerar uma versão nova, os agendamentos são reapontados sozinhos ao abrir (nunca durante uma verificação). Depois de atualizar o código, rode `npm run package` de novo e substitua o app. Se o macOS reclamar que o app está danificado: `xattr -cr "/Applications/HD Checker.app"`.

## Vários discos ao mesmo tempo

Cada disco tem seu próprio job e pode ser verificado em paralelo com os outros (processos separados, um por disco). Em cada disco só roda **uma** verificação por vez: se você tentar iniciar outra (ou se o agendamento coincidir com uma execução manual), a segunda é pulada com um aviso, em vez de duplicar o trabalho. Execuções que morreram no meio (queda de energia, app encerrado à força) são detectadas e marcadas como interrompidas; os números de uma execução em andamento aparecem ao vivo em Relatórios.

Fechar a janela no macOS **não** interrompe as verificações; só "Sair" (⌘Q) as encerra.

## Saúde do disco (aba Discos)

- **Limpar "Arquivo sumiu" em lote**: em Relatórios, escolha o tipo "Arquivo sumiu" e digite as pastas (ex.: `2014, 2015`; vale para tudo dentro delas). Aparece o total e o botão "Foi apagado de propósito — todos", que pede confirmação e resolve todos de uma vez (respeitando o disco escolhido no filtro).
- **Checar sistema de arquivos**: roda `diskutil verifyVolume` (só leitura, mas o macOS desmonta o disco por alguns minutos e remonta no fim). Não roda enquanto há verificação no disco. O resultado fica no histórico (Relatórios → Saúde dos discos). Em exFAT, que não tem journal, vale rodar depois de qualquer desligamento sem ejetar.
- **Ejetar**: `diskutil eject`, para desconectar com segurança. Se o macOS recusar porque algum programa está usando o disco, o app mostra **quem** é (via `lsof`: nome e PID) e, com a sua confirmação, pede que os programas do seu usuário terminem (SIGTERM, nunca à força; nunca root, launchd nem o próprio app) e tenta ejetar de novo. Não use se algo estiver copiando arquivos para o disco.
- **Verificação completa**: lê **100%** do disco, sem limite de horário e sem depender de job configurado (se o disco não tem job, o app cria um, desativado). É a rodada para a 1ª catalogação ou para uma conferência geral. Se ela for interrompida (disco desconectado, parada manual), o card do disco mostra **Continuar de onde parou**: a nova execução pula os arquivos que as execuções interrompidas já leram e verifica só o que faltou.
- **Verificação das mudanças**: lê apenas arquivos novos ou alterados (e os que já têm erro aberto); use logo depois de copiar fotos para o disco.
- **Agendamento**: abre o job do disco. Frequência, dia, horário, fatia por execução e limite de duração só valem para a execução agendada.

## Ferramentas → Comparar cópia

Compara uma pasta de origem com uma de destino (cartão → HD, HD → HD) arquivo a arquivo, por hash. Só lê. Se o resultado não for "cópia idêntica", **não apague a origem**. A comparação rápida confere só existência e tamanho: pega arquivo faltando ou truncado, mas não um bit alterado.

## Linha de comando (opcional)
```bash
npm run cli -- run --job <id>      # roda como agendado (fatia e limite do job; use --json para saída em JSON, --no-email)
npm run cli -- run --job <id> --full       # 100% do disco, sem limite de horário
npm run cli -- run --job <id> --full --resume   # continua a verificação completa interrompida
npm run cli -- run --job <id> --only-new   # só arquivos novos/alterados
npm run cli -- run-all
npm run cli -- compare --src <pasta> --dst <pasta> [--quick]   # sai com código 3 se houver diferenças
npm run cli -- status              # cobertura e problemas por disco
npm run cli -- volumes
npm run cli -- test-email
```

## Testes
```bash
npm test   # núcleo (disco sintético), handlers do Electron (simulados) e a interface (jsdom)
```

## Limitações (leia)
- **O hash só prova que o arquivo não mudou desde que foi catalogado.** Se um arquivo já estava
  corrompido na 1ª catalogação, o hash guarda a versão corrompida. A validação de estrutura pega os casos
  grosseiros (vazio, truncado), mas **não decodifica os pixels**: um JPEG com blocos estragados no meio pode passar.
- Se o conteúdo mudar **e** o tamanho/data também mudarem, o app trata como edição legítima.
  O alvo aqui é a corrupção silenciosa, que não altera data nem tamanho.
- Alguns JPEGs de câmeras antigas não têm o marcador final (FFD9). Viram *aviso*, não erro.
- O app **não lê o SMART** do disco (HDs externos USB raramente o repassam ao macOS). A integridade física do disco é outra camada:
  corrupção em massa costuma ser sinal de HD morrendo, por isso vale manter uma segunda cópia local além da Backblaze.
- O inventário é de arquivos individuais; arquivos movidos entre discos aparecem como sumidos em um e novos no outro.
- Restaurar na Backblaze é manual (o app aponta o arquivo e o motivo; não fala com a Backblaze).

## Estrutura
```
electron/   main.js (IPC, processo filho, agendador) · preload.js
src/core/   scanner · checks · hashing · walk · db · mailer · scheduler · config · secrets · volumes
src/cli.js  mesma lógica, sem interface (é o que o launchd executa)
ui/         index.html · styles.css · app.js (JS puro, sem build)
test/       testes
```


## Licença
Projeto pessoal; sem licença definida (todos os direitos reservados) até que se escolha uma.
