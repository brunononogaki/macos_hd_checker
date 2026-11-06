# Baixar

## Requisitos

- macOS recente. O app empacotado serve à arquitetura do Mac que o gerou (Intel ou Apple Silicon); as notas de cada release dizem qual é. Se não servir para o seu Mac, gere o app você mesmo (abaixo).
- Um ou mais HDs/SSDs com fotos e vídeos (exFAT, APFS, HFS+...)
- Espaço pequeno em disco para o banco de dados (alguns megabytes para centenas de milhares de arquivos)

## Baixar o aplicativo

[:material-download: Baixar a última versão](https://github.com/brunononogaki/macos_hd_checker/releases/latest){ .md-button .md-button--primary }

Na página de *Releases*, baixe o arquivo `HD-Checker-<versão>-macos.zip`, descompacte e arraste **HD Checker.app** para a pasta **Aplicativos**.

!!! info "Ainda não há release publicada?"
    Se a página de releases estiver vazia, [gere o app você mesmo](#gerar-o-app-a-partir-do-codigo-fonte) em poucos minutos.

### Primeira abertura (app sem assinatura da Apple)

O app é de código aberto e **não é assinado** com um certificado pago da Apple. Por isso o macOS pede uma confirmação na primeira vez:

1. Clique com o **botão direito** em *HD Checker.app* → **Abrir** → **Abrir**.
2. Se aparecer "o app está danificado e não pode ser aberto", rode no Terminal:

   ```bash
   xattr -cr "/Applications/HD Checker.app"
   ```

3. Quando o macOS perguntar sobre acesso a **volumes removíveis**, aceite. É assim que o app enxerga seus HDs.

## Gerar o app a partir do código-fonte

Precisa de [Node.js](https://nodejs.org) 22.13 ou mais novo.

```bash
git clone https://github.com/brunononogaki/macos_hd_checker.git
cd macos_hd_checker
npm install
npm run package      # gera dist/HD Checker.app
```

Arraste `dist/HD Checker.app` para Aplicativos. Para só experimentar sem empacotar:

```bash
npm start
```

!!! note "Atualizando"
    Depois de baixar uma versão nova (ou atualizar o código), gere/substitua o app. Os agendamentos são reapontados sozinhos ao abrir o app novo (nunca durante uma verificação), e o inventário é mantido.

## Permissões do macOS

- **Verificações agendadas** rodam pelo `launchd` usando o binário do app. Se uma execução agendada não enxergar o disco, dê **Acesso total ao disco** ao app em *Ajustes do Sistema → Privacidade e Segurança*.
- O Mac precisa estar ligado (ou dormindo: o `launchd` roda ao acordar) e com o HD conectado no horário. Se o disco não estiver conectado, a execução é pulada e registrada.
- Durante uma verificação o app impede o Mac de dormir (`caffeinate`), porque dormir no meio de uma leitura em exFAT é arriscado.
