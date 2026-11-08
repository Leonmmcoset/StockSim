FROM node:24-bookworm-slim AS frontend
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig*.json ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM golang:1.26-bookworm AS backend
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/stocksim ./cmd/stocksim
RUN mkdir /out/data

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=backend --chown=65532:65532 /out/stocksim /app/stocksim
COPY --from=backend --chown=65532:65532 /out/data /data
COPY --from=frontend --chown=65532:65532 /src/dist /app/web
ENV STOCKSIM_ADDR=0.0.0.0:8080 STOCKSIM_DB=/data/stocksim.db STOCKSIM_STATIC_DIR=/app/web
EXPOSE 8080
VOLUME ["/data"]
USER 65532:65532
ENTRYPOINT ["/app/stocksim"]
