# Plain Node image. No privileged mode, no special capabilities.
# This is exactly why it runs on Railway where nsjail cannot.
FROM node:20-slim
 
# Keep this in lockstep with the "pyodide" version in package.json.
ARG PYODIDE_VERSION=0.27.7
 
WORKDIR /app
 
RUN apt-get update && apt-get install -y --no-install-recommends curl bzip2 \
    && rm -rf /var/lib/apt/lists/*
 
# Bundle the FULL Pyodide distribution (runtime + all package wheels) into the
# image so there are zero external CDN calls at runtime. Requires outbound
# network at BUILD time only (Railway allows this).
RUN curl -fsSL -o /tmp/pyodide.tar.bz2 \
      "https://github.com/pyodide/pyodide/releases/download/${PYODIDE_VERSION}/pyodide-${PYODIDE_VERSION}.tar.bz2" \
    && tar xjf /tmp/pyodide.tar.bz2 -C /app \
    && mv /app/pyodide /app/pyodide-dist \
    && rm /tmp/pyodide.tar.bz2
ENV PYODIDE_INDEX_URL=/app/pyodide-dist/
 
# Install deps (the npm "pyodide" package provides the loadPyodide loader).
COPY package.json ./
RUN npm install --omit=dev
 
# Source files live at the repo root (flat layout), not in a src/ folder.
COPY server.js sessions.js storage.js worker.js ./
 
# Pre-create the data dir (override DATA_DIR to a Railway volume in prod).
RUN mkdir -p /data/files
 
ENV PORT=8000
EXPOSE 8000
 
CMD ["node", "server.js"]
