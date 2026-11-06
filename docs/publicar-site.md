# Publicar este site

O site é gerado com [MkDocs](https://www.mkdocs.org) e o tema [Material](https://squidfunk.github.io/mkdocs-material/). O resultado é um conjunto de arquivos estáticos que qualquer servidor web serve.

## Pré-visualizar localmente

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-docs.txt
mkdocs serve          # http://127.0.0.1:8000
```

## Gerar os arquivos estáticos

```bash
mkdocs build          # cria a pasta site/
```

Antes de publicar, troque o `site_url` no `mkdocs.yml` pelo endereço real do site.

## Opção A: copiar para a VPS (nginx)

```bash
rsync -avz --delete site/ usuario@sua-vps:/var/www/hdchecker/
```

Exemplo de bloco do nginx (`deploy/nginx.conf` traz um modelo completo):

```nginx
server {
    listen 80;
    server_name hdchecker.exemplo.com;
    root /var/www/hdchecker;
    index index.html;
    location / { try_files $uri $uri/ =404; }
}
```

Para HTTPS, use o [certbot](https://certbot.eff.org): `sudo certbot --nginx -d hdchecker.exemplo.com`.

## Opção B: Docker

O `Dockerfile.docs` gera o site e o serve com nginx:

```bash
docker build -f Dockerfile.docs -t hdchecker-docs .
docker run -d --name hdchecker-docs -p 8080:80 --restart unless-stopped hdchecker-docs
```

Coloque um proxy reverso (nginx, Caddy ou Traefik) na frente para o domínio e o HTTPS.

## Atualizando o site

Depois de mudar qualquer página em `docs/`, rode de novo o `mkdocs build` e o `rsync` (ou reconstrua a imagem Docker). O workflow `.github/workflows/docs.yml` confere automaticamente se o site compila a cada push.
