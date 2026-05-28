FROM node:20-alpine
RUN apk add --no-cache ffmpeg python3 py3-pip
RUN pip3 install --break-system-packages openai-whisper
WORKDIR /app
COPY package.json .
RUN npm install
COPY server.js .
EXPOSE 3000
CMD ["node", "server.js"]
