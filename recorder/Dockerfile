FROM node:20-slim

# System deps: ffmpeg + python3 + pip
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    python3-dev \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# Python ML deps
RUN pip3 install --break-system-packages \
    tensorflow-cpu \
    tensorflow-hub \
    soundfile \
    numpy

WORKDIR /app
COPY package.json .
RUN npm install
COPY server.js .
COPY classify.py .

EXPOSE 3000
CMD ["node", "server.js"]
