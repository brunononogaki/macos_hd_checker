# Desenvolvimento

O HD Checker é um app [Electron](https://www.electronjs.org) em JavaScript puro, sem módulos nativos: o banco usa o `node:sqlite` embutido (Node ≥ 22.13 / Electron ≥ 37). Contribuições são bem-vindas.

## Rodando

```bash
git clone https://github.com/brunononogaki/macos_hd_checker.git
cd macos_hd_checker
npm install
npm start            # abre o app
npm test             # núcleo, handlers do Electron (simulados) e interface (jsdom)
npm run package      # gera dist/HD Checker.app
```

## Estrutura

| Pasta | O que tem |
|---|---|
| `electron/` | Processo principal (`main.js`, IPC) e `preload.js` |
| `ui/` | Interface (HTML, CSS e JS sem framework) |
| `src/core/` | Núcleo: varredura (`scanner.js`), validações (`checks.js`), banco (`db.js`), agendamento (`scheduler.js`), saúde do disco (`diskcheck.js`), e-mail e configuração |
| `src/cli.js` | Linha de comando (o app roda as verificações por ela, uma por disco) |
| `scripts/` | Empacotamento do `.app` |
| `test/` | Testes (usam discos sintéticos em pastas temporárias) |
| `docs/` | Este site (MkDocs) |

!!! info "Detalhes importantes"
    - A interface roda com uma política de conteúdo restrita (`style-src 'self'`): não use `style="..."` em HTML. O helper `h()` aplica estilos via CSSOM.
    - As verificações rodam em **processos separados** (um por disco), nunca dentro do processo da janela.
    - O app só lê os discos. Qualquer mudança não deve escrever neles.

## Versões e releases

A versão do app vem do campo `version` do `package.json` (semver) e aparece no rodapé da interface.

1. Atualize `package.json` (e o [histórico de versões](changelog.md)).
2. Gere o app e compacte-o:

   ```bash
   npm run package
   cd dist && ditto -c -k --sequesterRsrc --keepParent "HD Checker.app" "HD-Checker-<versão>-macos.zip"
   ```

3. Crie uma *release* no GitHub com a tag `v<versão>` e anexe o `.zip`. O botão de download do site aponta para a última release.

## Licença

[MIT](https://github.com/brunononogaki/macos_hd_checker/blob/main/LICENSE).
