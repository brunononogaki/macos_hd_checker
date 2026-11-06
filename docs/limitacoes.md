# Limitações

!!! danger "O hash só prova que o arquivo não mudou desde que foi catalogado"
    Se um arquivo **já estava corrompido** na primeira catalogação, o inventário guarda a versão corrompida e o app não consegue saber.

- **Não decodifica os pixels.** A validação de estrutura pega os casos grosseiros (vazio, truncado, sem índice), mas um JPEG com blocos estragados no meio do arquivo pode passar.
- **Edição e corrupção ao mesmo tempo.** Se o conteúdo mudar **e** o tamanho ou a data também mudarem, o app trata como edição legítima.
- **Só macOS.** Depende do `diskutil`, `lsof`, `launchd` e do Keychain.
- **Não é um backup.** Ele avisa que algo estragou; quem guarda a versão boa é o seu backup.
- **App sem assinatura da Apple.** Veja [Baixar](download.md) para a primeira abertura.
- **Um disco, uma verificação por vez.** Discos diferentes rodam em paralelo.
