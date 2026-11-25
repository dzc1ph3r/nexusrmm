package main

import (
	"context"
	"flag"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nexusrmm/nexusrmm/server/internal/config"
	"github.com/nexusrmm/nexusrmm/server/internal/agent"
	"github.com/nexusrmm/nexusrmm/server/internal/transport"
	"github.com/nexusrmm/nexusrmm/server/pkg/tlsutil"
	"github.com/redis/go-redis/v9"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

func main() {
	var configPath string
	flag.StringVar(&configPath, "config", "", "Path to config file")
	flag.Parse()

	// Setup logging
	zerolog.TimeFieldFormat = zerolog.TimeFormatUnix
	log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.RFC3339})

	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		log.Fatal().Err(err).Msg("Failed to load config")
	}

	// Override config path if provided
	if configPath != "" {
		// TODO: Load from specific path
	}

	// Initialize database
	dbPool, err := initDatabase(cfg)
	if err != nil {
		log.Fatal().Err(err).Msg("Failed to connect to database")
	}
	defer dbPool.Close()

	// Initialize Redis
	redisClient, err := initRedis(cfg)
	if err != nil {
		log.Fatal().Err(err).Msg("Failed to connect to Redis")
	}
	defer redisClient.Close()

	// Initialize CA
	ca, err := initCA(cfg)
	if err != nil {
		log.Fatal().Err(err).Msg("Failed to initialize CA")
	}

	// Initialize enrollment manager
	enrollmentMgr := agent.NewEnrollmentManager(dbPool, redisClient, ca)

	// Initialize TLS config
	tlsConfig, err := cfg.TLSConfig()
	if err != nil {
		log.Fatal().Err(err).Msg("Failed to create TLS config")
	}

	// Create WebSocket transport
	wsTransport := transport.NewWSTransport(enrollmentMgr, ca.Cert, &tlsConfig.Certificates[0])

	// HTTP server for health check
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})

	healthServer := &http.Server{
		Addr:         cfg.Server.Host + ":" + string(rune(cfg.Server.Port)),
		Handler:      mux,
		ReadTimeout:  cfg.Server.ReadTimeout,
		WriteTimeout: cfg.Server.WriteTimeout,
		IdleTimeout:  cfg.Server.IdleTimeout,
	}

	// Start health server
	go func() {
		log.Info().Str("addr", healthServer.Addr).Msg("Starting health check server")
		var err error
		if cfg.TLS.CertFile != "" && cfg.TLS.KeyFile != "" {
			err = healthServer.ListenAndServeTLS(cfg.TLS.CertFile, cfg.TLS.KeyFile)
		} else {
			err = healthServer.ListenAndServe()
		}
		if err != nil && err != http.ErrServerClosed {
			log.Error().Err(err).Msg("Health server failed")
		}
	}()

	// Start WebSocket transport server
	wsAddr := cfg.Server.Host + ":" + string(rune(cfg.Server.Port+1)) // Use different port for WS
	go func() {
		log.Info().Str("addr", wsAddr).Msg("Starting WebSocket transport server")
		if err := wsTransport.Start(wsAddr); err != nil {
			log.Error().Err(err).Msg("WebSocket transport server failed")
		}
	}()

	// Wait for shutdown signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	log.Info().Msg("Shutting down server...")

	// Graceful shutdown
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	wsTransport.Stop()
	if err := healthServer.Shutdown(ctx); err != nil {
		log.Error().Err(err).Msg("Health server shutdown error")
	}

	log.Info().Msg("Server stopped")
}

func initDatabase(cfg *config.Config) (*pgxpool.Pool, error) {
	poolConfig, err := pgxpool.ParseConfig(cfg.DatabaseDSN())
	if err != nil {
		return nil, err
	}
	poolConfig.MaxConns = cfg.Database.MaxConns
	poolConfig.MinConns = 5
	poolConfig.MaxConnLifetime = time.Hour
	poolConfig.MaxConnIdleTime = 30 * time.Minute

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, err
	}

	// Test connection
	if err := pool.Ping(ctx); err != nil {
		return nil, err
	}

	log.Info().Msg("Database connected")
	return pool, nil
}

func initRedis(cfg *config.Config) (*redis.Client, error) {
	client := redis.NewClient(&redis.Options{
		Addr:     cfg.RedisAddr(),
		Password: cfg.Redis.Password,
		DB:       cfg.Redis.DB,
		PoolSize: cfg.Redis.PoolSize,
	})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := client.Ping(ctx).Err(); err != nil {
		return nil, err
	}

	log.Info().Msg("Redis connected")
	return client, nil
}

func initCA(cfg *config.Config) (*tlsutil.CA, error) {
	// In production, load from HSM or secure storage
	// For development, generate or load from files
	caDir := "/etc/nexusrmm/ca"
	certFile := filepath.Join(caDir, "ca.crt")
	keyFile := filepath.Join(caDir, "ca.key")

	if _, err := os.Stat(certFile); err == nil {
		// Load existing CA
		ca, err := tlsutil.LoadCA(certFile, keyFile)
		if err != nil {
			return nil, err
		}
		log.Info().Msg("Loaded existing CA")
		return ca, nil
	}

	// Generate new CA for development
	ca, err := tlsutil.NewCA("Nexus RMM Root CA", 10*365*24*time.Hour)
	if err != nil {
		return nil, err
	}

	// Save CA
	if err := os.MkdirAll(caDir, 0700); err != nil {
		return nil, err
	}
	if err := ca.SaveCA(certFile, keyFile); err != nil {
		return nil, err
	}

	log.Info().Msg("Generated new CA")
	return ca, nil
}
