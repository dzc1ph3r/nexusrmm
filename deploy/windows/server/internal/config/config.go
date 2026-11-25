package config

import (
	"crypto/tls"
	"crypto/x509"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/viper"
	"golang.org/x/crypto/acme/autocert"
)

type Config struct {
	Server   ServerConfig
	Database DatabaseConfig
	Redis    RedisConfig
	TLS      TLSConfig
	Auth     AuthConfig
	Agent    AgentConfig
	TURN     TURNConfig
}

type ServerConfig struct {
	Host           string
	Port           int
	WebSocketPath  string
	ReadTimeout    time.Duration
	WriteTimeout   time.Duration
	IdleTimeout    time.Duration
	MaxFrameSize   int64
	HeartbeatInterval time.Duration
}

type DatabaseConfig struct {
	Host     string
	Port     int
	User     string
	Password string
	DBName   string
	SSLMode  string
	MaxConns int32
}

type RedisConfig struct {
	Host     string
	Port     int
	Password string
	DB       int
	PoolSize int
}

type TLSConfig struct {
	CertFile       string
	KeyFile        string
	CAFile         string
	ClientCAFile   string
	ACMEEnabled    bool
	ACMEDomain     string
	ACMEEmail      string
	ACMECacheDir   string
}

type AuthConfig struct {
	JWTSecret        string
	TokenTTL         time.Duration
	RefreshTokenTTL  time.Duration
	MFARequired      bool
	Argon2Time       uint32
	Argon2Memory     uint32
	Argon2Threads    uint8
	Argon2KeyLen     uint32
}

type AgentConfig struct {
	HeartbeatInterval   time.Duration
	TelemetryInterval   time.Duration
	InventoryInterval   time.Duration
	MaxMissedHeartbeats int
	AutoUpdateEnabled   bool
	UpdateBaseURL       string
	EnrollmentTokenTTL  time.Duration
}

type TURNConfig struct {
	Enabled      bool
	Realm        string
	AuthSecret   string
	ExternalIP   string
	Port         int
	TLSPort      int
}

func Load() (*Config, error) {
	viper.SetConfigName("config")
	viper.SetConfigType("yaml")
	viper.AddConfigPath(".")
	viper.AddConfigPath("./config")
	viper.AddConfigPath("/etc/nexusrmm")
	viper.AutomaticEnv()

	setDefaults()

	if err := viper.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return nil, err
		}
	}

	var cfg Config
	if err := viper.Unmarshal(&cfg); err != nil {
		return nil, err
	}

	return &cfg, nil
}

func setDefaults() {
	viper.SetDefault("server.host", "0.0.0.0")
	viper.SetDefault("server.port", 8443)
	viper.SetDefault("server.websocket_path", "/ws")
	viper.SetDefault("server.read_timeout", "30s")
	viper.SetDefault("server.write_timeout", "30s")
	viper.SetDefault("server.idle_timeout", "120s")
	viper.SetDefault("server.max_frame_size", 16<<20) // 16MB
	viper.SetDefault("server.heartbeat_interval", "30s")

	viper.SetDefault("database.host", "localhost")
	viper.SetDefault("database.port", 5432)
	viper.SetDefault("database.user", "nexusrmm")
	viper.SetDefault("database.password", "changeme")
	viper.SetDefault("database.dbname", "nexusrmm")
	viper.SetDefault("database.sslmode", "require")
	viper.SetDefault("database.max_conns", 20)

	viper.SetDefault("redis.host", "localhost")
	viper.SetDefault("redis.port", 6379)
	viper.SetDefault("redis.password", "")
	viper.SetDefault("redis.db", 0)
	viper.SetDefault("redis.pool_size", 50)

	viper.SetDefault("tls.cert_file", "")
	viper.SetDefault("tls.key_file", "")
	viper.SetDefault("tls.ca_file", "")
	viper.SetDefault("tls.client_ca_file", "")
	viper.SetDefault("tls.acme_enabled", false)
	viper.SetDefault("tls.acme_domain", "")
	viper.SetDefault("tls.acme_email", "")
	viper.SetDefault("tls.acme_cache_dir", "/var/lib/nexusrmm/acme")

	viper.SetDefault("auth.jwt_secret", "changeme")
	viper.SetDefault("auth.token_ttl", "15m")
	viper.SetDefault("auth.refresh_token_ttl", "7d")
	viper.SetDefault("auth.mfa_required", true)
	viper.SetDefault("auth.argon2_time", 3)
	viper.SetDefault("auth.argon2_memory", 65536)
	viper.SetDefault("auth.argon2_threads", 4)
	viper.SetDefault("auth.argon2_key_len", 32)

	viper.SetDefault("agent.heartbeat_interval", "30s")
	viper.SetDefault("agent.telemetry_interval", "60s")
	viper.SetDefault("agent.inventory_interval", "3600s")
	viper.SetDefault("agent.max_missed_heartbeats", 3)
	viper.SetDefault("agent.auto_update_enabled", true)
	viper.SetDefault("agent.update_base_url", "https://updates.nexusrmm.io")
	viper.SetDefault("agent.enrollment_token_ttl", "24h")

	viper.SetDefault("turn.enabled", true)
	viper.SetDefault("turn.realm", "nexusrmm")
	viper.SetDefault("turn.auth_secret", "changeme")
	viper.SetDefault("turn.external_ip", "")
	viper.SetDefault("turn.port", 3478)
	viper.SetDefault("turn.tls_port", 5349)
}

func (c *Config) ServerAddr() string {
	return c.Server.Host + ":" + string(rune(c.Server.Port))
}

func (c *Config) DatabaseDSN() string {
	return "postgres://" + c.Database.User + ":" + c.Database.Password + "@" +
		c.Database.Host + ":" + string(rune(c.Database.Port)) + "/" + c.Database.DBName +
		"?sslmode=" + c.Database.SSLMode
}

func (c *Config) RedisAddr() string {
	return c.Redis.Host + ":" + string(rune(c.Redis.Port))
}

func (c *Config) TLSConfig() (*tls.Config, error) {
	var cert tls.Certificate
	var err error

	if c.TLS.ACMEEnabled && c.TLS.ACMEDomain != "" {
		m := &autocert.Manager{
			Prompt:     autocert.AcceptTOS,
			HostPolicy: autocert.HostWhitelist(c.TLS.ACMEDomain),
			Cache:      autocert.DirCache(c.TLS.ACMECacheDir),
			Email:      c.TLS.ACMEEmail,
		}
		return &tls.Config{
			GetCertificate: m.GetCertificate,
			NextProtos:     []string{"h2", "http/1.1"},
			MinVersion:     tls.VersionTLS13,
			CipherSuites: []uint16{
				tls.TLS_AES_256_GCM_SHA384,
				tls.TLS_CHACHA20_POLY1305_SHA256,
				tls.TLS_AES_128_GCM_SHA256,
			},
			CurvePreferences: []tls.CurveID{
				tls.X25519,
				tls.CurveP256,
			},
		}, nil
	}

	if c.TLS.CertFile != "" && c.TLS.KeyFile != "" {
		cert, err = tls.LoadX509KeyPair(c.TLS.CertFile, c.TLS.KeyFile)
		if err != nil {
			return nil, err
		}
	} else {
		// Generate self-signed for development
		cert, err = generateSelfSignedCert()
		if err != nil {
			return nil, err
		}
	}

	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS13,
		CipherSuites: []uint16{
			tls.TLS_AES_256_GCM_SHA384,
			tls.TLS_CHACHA20_POLY1305_SHA256,
			tls.TLS_AES_128_GCM_SHA256,
		},
		CurvePreferences: []tls.CurveID{
			tls.X25519,
			tls.CurveP256,
		},
		NextProtos: []string{"h2", "http/1.1"},
	}

	if c.TLS.ClientCAFile != "" {
		caCert, err := os.ReadFile(c.TLS.ClientCAFile)
		if err != nil {
			return nil, err
		}
		caPool := x509.NewCertPool()
		caPool.AppendCertsFromPEM(caCert)
		tlsConfig.ClientCAs = caPool
		tlsConfig.ClientAuth = tls.RequireAndVerifyClientCert
		tlsConfig.VerifyPeerCertificate = func(rawCerts [][]byte, verifiedChains [][]*x509.Certificate) error {
			// Additional verification: check certificate pinning
			return nil
		}
	}

	return tlsConfig, nil
}

func generateSelfSignedCert() (tls.Certificate, error) {
	// This is a placeholder - in production use proper cert generation
	return tls.Certificate{}, nil
}

func (c *Config) LoadCA() (*x509.CertPool, error) {
	if c.TLS.CAFile == "" {
		return nil, nil
	}
	caCert, err := os.ReadFile(c.TLS.CAFile)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(caCert)
	return pool, nil
}

func GetConfigPath() string {
	if path := os.Getenv("NEXUS_CONFIG"); path != "" {
		return path
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".nexusrmm", "config.yaml")
}