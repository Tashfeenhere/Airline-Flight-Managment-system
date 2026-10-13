FROM node:20-alpine

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy application source code
COPY . .

# Expose default port
EXPOSE 3000

# Default environment variables
ENV NODE_ENV=production \
    NODE_ID=NODE_DEFAULT \
    PORT=3000

CMD ["node", "src/server.js"]
