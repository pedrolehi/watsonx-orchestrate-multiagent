# Use a imagem oficial do Node.js baseada no Alpine para menor tamanho
FROM node:20-alpine

# Instalar o pnpm globalmente
RUN npm install -g pnpm

# Ajustar timezone para Sao Paulo/Brasilia
ENV TZ=America/Sao_Paulo
RUN apk add --no-cache tzdata \
    && cp /usr/share/zoneinfo/$TZ /etc/localtime \
    && echo $TZ > /etc/timezone \
    && apk del tzdata

# Definir o diretório de trabalho dentro do container
WORKDIR /app

# Copiar arquivos de configuração do package manager
COPY package.json pnpm-lock.yaml ./

# Instalar as dependências
RUN pnpm install --frozen-lockfile

# Copiar o código fonte
COPY . .

# Garante que qualquer build antiga seja removida
RUN rm -rf dist

# Compilar a aplicação
RUN pnpm run build

# Expor a porta que a aplicação irá usar
EXPOSE 3000

# Definir o usuário não-root para segurança
USER node

# Comando para iniciar a aplicação
CMD ["pnpm", "run", "start:prod"]
