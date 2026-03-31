FROM node:22-slim

RUN npm install -g @tokligence/gateway

WORKDIR /app
COPY tgw-proxy.mjs ./
COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 8080

CMD ["./entrypoint.sh"]
