# Linha de comando

O app também funciona sem interface, o que é útil para automação. Dentro da pasta do projeto:

```bash
npm run cli -- run --job <id>                    # como agendado: usa a fatia e o limite do agendamento (--json, --no-email)
npm run cli -- run --job <id> --full             # 100% do disco, sem limite de horário
npm run cli -- run --job <id> --full --resume    # continua a verificação completa interrompida
npm run cli -- run --job <id> --only-new         # só arquivos novos ou alterados
npm run cli -- run-all                           # roda todos os agendamentos
npm run cli -- status                            # cobertura e problemas por disco
npm run cli -- volumes                           # volumes montados
npm run cli -- test-email                        # envia um e-mail de teste
```

| Opção | Efeito |
|---|---|
| `--json` | Saída em linhas JSON (progresso, plano e resultado), usada pelo app. |
| `--no-email` | Não envia e-mail ao terminar. |
| `--full` | Lê 100% do disco e ignora fatia e limite de tempo. |
| `--resume` | Junto com `--full`: pula o que as execuções completas interrompidas já leram. |
| `--only-new` | Só arquivos novos ou alterados (e os que têm erro aberto). |

O `<id>` do agendamento aparece no arquivo de configuração (`config.json`, veja [Onde ficam os dados](dados.md)).
