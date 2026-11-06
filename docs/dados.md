# Onde ficam os dados

| O quê | Onde |
|---|---|
| Configuração | `~/Library/Application Support/hd_checker/config.json` |
| Inventário (SQLite) | `~/Library/Application Support/hd_checker/inventory.db` |
| Logs das execuções agendadas | `~/Library/Application Support/hd_checker/logs/` |
| Senha SMTP | Keychain do macOS (serviço `hd_checker_smtp`) |
| Agendamentos | `~/Library/LaunchAgents/com.hdchecker.job.<id>.plist` |

## Por que o banco não fica em Documentos

O iCloud Drive pode corromper um SQLite em uso, então o banco fica em *Application Support*, fora das pastas sincronizadas. O botão **Mostrar no Finder**, em *Configurações → Inventário*, abre a pasta.

!!! warning "Inclua esta pasta no seu backup"
    O inventário é a memória do app. Se ele for perdido, os discos precisam ser catalogados de novo.

## Privacidade

- Tudo roda **localmente**. O app não envia dados para a internet.
- A única comunicação externa é o **e-mail de aviso** que você configura (servidor SMTP escolhido por você).
- A senha do SMTP é guardada no Keychain, não em arquivo.
- O app só **lê** os seus discos.

## Desinstalar

1. Exclua os agendamentos no app (isso remove os arquivos do `launchd`) e saia do app.
2. Apague `HD Checker.app` de Aplicativos.
3. Opcional: apague `~/Library/Application Support/hd_checker/` (config, inventário e logs).
