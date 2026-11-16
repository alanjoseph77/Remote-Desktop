FROM node:22-alpine
WORKDIR /srv
COPY server/package.json ./
RUN npm install --omit=dev
COPY server/index.js ./
ENV PORT=8080 DATA_FILE=/data/ids.json
VOLUME /data
EXPOSE 8080
CMD ["node", "index.js"]
