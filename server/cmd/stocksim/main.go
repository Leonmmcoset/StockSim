package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"stocksim/server/internal/app"
	"strconv"
	"syscall"
	"time"
)

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	secure := false
	value := env("STOCKSIM_SECURE_COOKIE", "auto")
	if value != "auto" {
		var err error
		secure, err = strconv.ParseBool(value)
		if err != nil {
			return fmt.Errorf("STOCKSIM_SECURE_COOKIE must be auto, true or false")
		}
	}
	a, err := app.New(app.Config{DBPath: env("STOCKSIM_DB", "data/stocksim.db"), Seed: env("STOCKSIM_SEED", "stock-sim-2026"), StaticDir: env("STOCKSIM_STATIC_DIR", "../dist"), PublicOrigin: os.Getenv("STOCKSIM_PUBLIC_ORIGIN"), SecureCookies: secure})
	if err != nil {
		return err
	}
	defer a.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	server := &http.Server{Addr: env("STOCKSIM_ADDR", "127.0.0.1:8080"), Handler: a.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 * 1024}
	clockDone := make(chan struct{})
	go func() {
		defer close(clockDone)
		a.Run(ctx, func(err error) { log.Printf("market tick not committed: %v", err) })
	}()
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		a.Close()
		if err := server.Shutdown(shutdown); err != nil {
			log.Printf("http shutdown: %v", err)
		}
	}()
	log.Printf("StockSim listening on %s", server.Addr)
	listenErr := server.ListenAndServe()
	stop()
	<-clockDone
	<-shutdownDone
	if listenErr != nil && !errors.Is(listenErr, http.ErrServerClosed) {
		return listenErr
	}
	return nil
}
