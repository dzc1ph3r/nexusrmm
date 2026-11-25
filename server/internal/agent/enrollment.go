package agent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	v1 "github.com/nexusrmm/nexusrmm/proto/gen/go/rmm"
	"github.com/nexusrmm/nexusrmm/server/pkg/tlsutil"
	"github.com/redis/go-redis/v9"
)

var (
	ErrInvalidToken       = errors.New("invalid or expired enrollment token")
	ErrInvalidSignature   = errors.New("invalid signature")
	ErrAgentExists        = errors.New("agent already enrolled")
	ErrChallengeExpired   = errors.New("challenge expired")
	ErrInvalidChallenge   = errors.New("invalid challenge")
	ErrTokenExhausted     = errors.New("enrollment token exhausted")
)

const (
	challengeSize    = 32
	challengeTTL     = 5 * time.Minute
	maxTokenUses     = 100
	agentIDPrefix    = "agt_"
	challengePrefix  = "enroll:challenge:"
	tokenPrefix      = "enroll:token:"
	pendingPrefix    = "enroll:pending:"
)

type EnrollmentManager struct {
	db        *pgxpool.Pool
	redis     *redis.Client
	ca        *tlsutil.CA
	mu        sync.RWMutex
	pending   map[string]*EnrollmentSession
}

type EnrollmentSession struct {
	AgentID       string
	Ed25519PubKey ed25519.PublicKey
	Challenge     []byte
	ServerNonce   string
	AgentNonce    string
	CSR           []byte
	Token         string
	TenantID      string
	ExpiresAt     time.Time
	CreatedAt     time.Time
}

func NewEnrollmentManager(db *pgxpool.Pool, redis *redis.Client, ca *tlsutil.CA) *EnrollmentManager {
	return &EnrollmentManager{
		db:      db,
		redis:   redis,
		ca:      ca,
		pending: make(map[string]*EnrollmentSession),
	}
}

// HandleEnrollRequest processes an enrollment request from an agent
func (em *EnrollmentManager) HandleEnrollRequest(ctx context.Context, req *v1.EnrollRequest) (*v1.EnrollChallenge, error) {
	// Validate enrollment token
	tokenData, err := em.validateToken(ctx, req.EnrollmentToken)
	if err != nil {
		return nil, err
	}

	// Check if agent already exists (by machine_id)
	existingAgent, err := em.getAgentByMachineID(ctx, req.MachineId)
	if err == nil && existingAgent != nil {
		// Re-enrollment: return new challenge
		return em.createChallenge(ctx, existingAgent.AgentID, req.Ed25519Pubkey, req.CsrDer, req.EnrollmentToken, tokenData.TenantID)
	}

	// Generate agent ID
	agentID := generateAgentID()

	// Store pending enrollment
	_ = &EnrollmentSession{
		AgentID:       agentID,
		Ed25519PubKey: req.Ed25519Pubkey,
		CSR:           req.CsrDer,
		Token:         req.EnrollmentToken,
		TenantID:      tokenData.TenantID,
		CreatedAt:     time.Now(),
	}

	return em.createChallenge(ctx, agentID, req.Ed25519Pubkey, req.CsrDer, req.EnrollmentToken, tokenData.TenantID)
}

func (em *EnrollmentManager) createChallenge(ctx context.Context, agentID string, pubKey, csr []byte, token, tenantID string) (*v1.EnrollChallenge, error) {
	// Generate challenge
	challenge := make([]byte, challengeSize)
	if _, err := rand.Read(challenge); err != nil {
		return nil, err
	}

	serverNonce := generateNonce()
	expiresAt := time.Now().Add(challengeTTL)

	// Store challenge in Redis with TTL
	challengeKey := challengePrefix + agentID
	challengeData := map[string]interface{}{
		"challenge":     hex.EncodeToString(challenge),
		"server_nonce":  serverNonce,
		"agent_id":      agentID,
		"pub_key":       hex.EncodeToString(pubKey),
		"csr":           hex.EncodeToString(csr),
		"token":         token,
		"tenant_id":     tenantID,
		"expires_at":    expiresAt.Unix(),
	}

	if err := em.redis.HSet(ctx, challengeKey, challengeData).Err(); err != nil {
		return nil, err
	}
	if err := em.redis.Expire(ctx, challengeKey, challengeTTL).Err(); err != nil {
		return nil, err
	}

	return &v1.EnrollChallenge{
		Challenge:   challenge,
		ServerNonce: serverNonce,
		ExpiresAt:   expiresAt.Unix(),
	}, nil
}

// HandleEnrollResponse processes the agent's signed challenge response
func (em *EnrollmentManager) HandleEnrollResponse(ctx context.Context, resp *v1.EnrollResponse) (*v1.EnrollResult, error) {
	// Retrieve challenge from Redis
	// We need to find the challenge by matching the signed challenge
	// For simplicity, we'll iterate pending challenges (in production, use agent nonce)

	challengeData, err := em.findChallengeBySignature(ctx, resp.Challenge, resp.Signature)
	if err != nil {
		return nil, err
	}

	if challengeData == nil {
		return nil, ErrInvalidChallenge
	}

	// Verify challenge hasn't expired
	expiresAt := time.Unix(challengeData["expires_at"].(int64), 0)
	if time.Now().After(expiresAt) {
		em.redis.Del(ctx, challengePrefix+challengeData["agent_id"].(string))
		return nil, ErrChallengeExpired
	}

	// Verify signature
	pubKeyBytes, _ := hex.DecodeString(challengeData["pub_key"].(string))
	pubKey := ed25519.PublicKey(pubKeyBytes)

	// Verify signature over challenge + server_nonce
	message := append(resp.Challenge, []byte(challengeData["server_nonce"].(string))...)
	if !tlsutil.VerifyEd25519Signature(pubKey, message, resp.Signature) {
		return nil, ErrInvalidSignature
	}

	agentID := challengeData["agent_id"].(string)
	tenantID := challengeData["tenant_id"].(string)

	// Issue mTLS certificate
	cert, certDER, err := em.ca.IssueAgentCertificate(agentID, tenantID, pubKey, 90*24*time.Hour)
	if err != nil {
		return nil, err
	}

	caCertDER := em.ca.Cert.Raw

	// Store agent in database
	if err := em.storeAgent(ctx, &AgentRecord{
		AgentID:       agentID,
		TenantID:      tenantID,
		Ed25519PubKey: pubKeyBytes,
		CertSerial:    cert.SerialNumber.String(),
		CertExpiresAt: cert.NotAfter,
		Hostname:      "", // Will be updated on hello
		MachineID:     "", // Will be updated on hello
		OS:            "",
		Arch:          "",
		Status:        "enrolled",
		EnrolledAt:    time.Now(),
	}); err != nil {
		return nil, err
	}

	// Increment token usage
	em.incrementTokenUsage(ctx, challengeData["token"].(string))

	// Clean up challenge
	em.redis.Del(ctx, challengePrefix+agentID)

	// Return enrollment result
	return &v1.EnrollResult{
		Success:        true,
		AgentId:        agentID,
		CertDer:        certDER,
		CaCertDer:      caCertDER,
		CertExpiresAt:  cert.NotAfter.Unix(),
		Config:         em.getAgentConfig(),
	}, nil
}

func (em *EnrollmentManager) findChallengeBySignature(ctx context.Context, challenge, signature []byte) (map[string]interface{}, error) {
	// In production, use Redis SCAN or maintain index
	// For now, we'll use a simpler approach: store challenge with agent_id key
	// The agent should include agent_id in the response or we track by connection
	return nil, ErrInvalidChallenge
}

func (em *EnrollmentManager) validateToken(ctx context.Context, token string) (*TokenData, error) {
	if token == "" {
		return nil, ErrInvalidToken
	}

	tokenKey := tokenPrefix + token
	data, err := em.redis.HGetAll(ctx, tokenKey).Result()
	if err != nil {
		return nil, ErrInvalidToken
	}
	if len(data) == 0 {
		return nil, ErrInvalidToken
	}

	// Check expiration
	if expStr, ok := data["expires_at"]; ok {
		expiresAt, _ := time.Parse(time.RFC3339, expStr)
		if time.Now().After(expiresAt) {
			return nil, ErrInvalidToken
		}
	}

	// Check usage
	used := 0
	if usedStr, ok := data["used_count"]; ok {
		fmt.Sscanf(usedStr, "%d", &used)
	}
	maxUses := 1
	if maxStr, ok := data["max_uses"]; ok {
		fmt.Sscanf(maxStr, "%d", &maxUses)
	}
	if used >= maxUses {
		return nil, ErrTokenExhausted
	}

	return &TokenData{
		Token:     token,
		TenantID:  data["tenant_id"],
		Scopes:    []string{}, // Parse from data
		MaxUses:   maxUses,
		UsedCount: used,
	}, nil
}

func (em *EnrollmentManager) incrementTokenUsage(ctx context.Context, token string) error {
	tokenKey := tokenPrefix + token
	return em.redis.HIncrBy(ctx, tokenKey, "used_count", 1).Err()
}

func (em *EnrollmentManager) getAgentByMachineID(ctx context.Context, machineID string) (*AgentRecord, error) {
	// Query database for agent by machine_id
	return nil, nil // Not implemented
}

func (em *EnrollmentManager) storeAgent(ctx context.Context, agent *AgentRecord) error {
	// Insert into PostgreSQL
	query := `
		INSERT INTO agents (agent_id, tenant_id, ed25519_pubkey, cert_serial, cert_expires_at, hostname, machine_id, os, arch, status, enrolled_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT (agent_id) DO UPDATE SET
			cert_serial = EXCLUDED.cert_serial,
			cert_expires_at = EXCLUDED.cert_expires_at,
			hostname = EXCLUDED.hostname,
			os = EXCLUDED.os,
			arch = EXCLUDED.arch,
			status = EXCLUDED.status
	`
	_, err := em.db.Exec(ctx, query,
		agent.AgentID, agent.TenantID, agent.Ed25519PubKey,
		agent.CertSerial, agent.CertExpiresAt,
		agent.Hostname, agent.MachineID, agent.OS, agent.Arch,
		agent.Status, agent.EnrolledAt,
	)
	return err
}

func (em *EnrollmentManager) getAgentConfig() map[string]string {
	return map[string]string{
		"heartbeat_interval_sec": "30",
		"telemetry_interval_sec": "60",
		"inventory_interval_sec": "3600",
		"log_level":              "info",
		"auto_update":            "true",
	}
}

type TokenData struct {
	Token     string
	TenantID  string
	Scopes    []string
	MaxUses   int
	UsedCount int
}

type AgentRecord struct {
	AgentID       string
	TenantID      string
	Ed25519PubKey []byte
	CertSerial    string
	CertExpiresAt time.Time
	Hostname      string
	MachineID     string
	OS            string
	Arch          string
	Status        string
	EnrolledAt    time.Time
}

func generateAgentID() string {
	b := make([]byte, 12)
	rand.Read(b)
	return agentIDPrefix + hex.EncodeToString(b)
}

func generateNonce() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// VerifyAgentHello verifies the agent's HELLO frame signature
func VerifyAgentHello(hello *v1.Hello, caCert *x509.Certificate) error {
	// Verify the signature over the hello payload
	// The signature covers: agent_id, agent_version, os, arch, hostname, machine_id, ed25519_pubkey, session_pubkey, timestamp
	payload := hello.AgentId + hello.AgentVersion + hello.Os + hello.Arch + hello.Hostname + hello.MachineId
	payloadBytes := []byte(payload)
	payloadBytes = append(payloadBytes, hello.Ed25519Pubkey...)
	payloadBytes = append(payloadBytes, hello.SessionPubkey...)
	payloadBytes = append(payloadBytes, []byte(fmt.Sprintf("%d", hello.Timestamp))...)

	pubKey := ed25519.PublicKey(hello.Ed25519Pubkey)
	if !tlsutil.VerifyEd25519Signature(pubKey, payloadBytes, hello.Signature) {
		return ErrInvalidSignature
	}

	// Verify timestamp is recent (within 5 minutes)
	if time.Since(time.Unix(hello.Timestamp, 0)) > 5*time.Minute {
		return errors.New("hello timestamp too old")
	}

	return nil
}

// CreateWelcome creates a WELCOME frame response
func CreateWelcome(sessionID uint64, serverSessionPubKey []byte, serverSigningKey ed25519.PrivateKey) (*v1.Welcome, error) {
	// Sign the welcome payload
	payload := fmt.Sprintf("%d%s%d", sessionID, hex.EncodeToString(serverSessionPubKey), time.Now().Unix())
	signature := tlsutil.SignEd25519(serverSigningKey, []byte(payload))

	return &v1.Welcome{
		Success:              true,
		SessionId:            sessionID,
		ServerSessionPubkey:  serverSessionPubKey,
		Signature:            signature,
		ServerTime:           time.Now().Unix(),
		Config:               map[string]string{"heartbeat_interval_sec": "30"},
	}, nil
}
