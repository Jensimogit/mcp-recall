FROM node:22-slim

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json package-lock.json* ./
RUN npm install --production

# Models are mounted via Docker volume — not baked into image
# Mount point: /app/models/

# Copy source, migrations, and scripts
COPY src/ src/
COPY migrations/ migrations/
COPY scripts/ scripts/

EXPOSE 3000

CMD ["node", "src/index.js"]
