package transport

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	v1 "github.com/nexusrmm/nexusrmm/proto/gen/go/rmm"
	"github.com/nexusrmm/nexusrmm/server/internal/agent"
	"github.com/nexusrmm/nexusrmm/server/pkg/mux"
	"github.com/rs/zerolog/log"
	"google.golang.org/protobuf/proto"
)

var (
	ErrInvalidCertificate = errors.New("invalid client certificate")
	ErrEnrollmentFailed   = errors.New("enrollment failed")
	ErrAgentNotFound      = errors.New("agent not found")
	ErrSessionClosed      = errors.New("session closed")
)

type WSTransport struct {
	server       *http.Server
	upgrader     websocket.Upgrader
	enrollMgr    *agent.EnrollmentManager
	frameCodec   *mux.FrameCodec
	frameRouter  *mux.FrameRouter
	sessions     map[uint64]*Session
	sessionsMu   sync.RWMutex
	caCert       *x509.Certificate
	serverCert   *tls.Certificate
}

type Session struct {
	ID            uint64
	AgentID       string
	TenantID      string
	Conn          *websocket.Conn
	Codec         *mux.FrameCodec
	Ctx           *mux.SessionContext
	CancelFunc    context.CancelFunc
	HeartbeatMgr  *mux.HeartbeatManager
	CreatedAt     time.Time
	LastActivity  time.Time
}

func NewWSTransport(enrollMgr *agent.EnrollmentManager, caCert *x509.Certificate, serverCert *tls.Certificate) *WSTransport {
	frameCodec := mux.NewFrameCodec()
	frameRouter := mux.NewFrameRouter()

	// Register frame handlers
	frameRouter.Register(v1.FrameType_FRAME_TYPE_HELLO, &HelloHandler{transport: nil})
	frameRouter.Register(v1.FrameType_FRAME_TYPE_HEARTBEAT, &HeartbeatHandler{})
	frameRouter.Register(v1.FrameType_FRAME_TYPE_VIDEO_FRAME, &DesktopFrameHandler{})
	frameRouter.Register(v1.FrameType_FRAME_TYPE_PTY_DATA, &TerminalDataHandler{})
	frameRouter.Register(v1.FrameType_FRAME_TYPE_FILE_TRANSFER, &FileTransferHandler{})
	frameRouter.Register(v1.FrameType_FRAME_TYPE_PROC_LIST, &ProcessListHandler{})
	frameRouter.Register(v1.FrameType_FRAME_TYPE_SCRIPT_OUTPUT, &ScriptOutputHandler{})
	frameRouter.Register(v1.FrameType_FRAME_TYPE_TELEMETRY, &TelemetryHandler{})

	upgrader := websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			// In production, validate origin against allowed domains
			return true
		},
		EnableCompression: true,
	}

	return &WSTransport{
		upgrader:    upgrader,
		enrollMgr:   enrollMgr,
		frameCodec:  frameCodec,
		frameRouter: frameRouter,
		sessions:    make(map[uint64]*Session),
		caCert:      caCert,
		serverCert:  serverCert,
	}
}

func (t *WSTransport) Start(addr string) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", t.handleWebSocket)
	mux.HandleFunc("/enroll", t.handleEnrollment)
	mux.HandleFunc("/enroll/response", t.handleEnrollResponse)
	mux.HandleFunc("/health", t.handleHealth)

	roots := x509.NewCertPool()
	roots.AddCert(t.caCert)

	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{*t.serverCert},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    roots,
		MinVersion:   tls.VersionTLS13,
		CipherSuites: []uint16{
			tls.TLS_AES_256_GCM_SHA384,
			tls.TLS_CHACHA20_POLY1305_SHA256,
			tls.TLS_AES_128_GCM_SHA256,
		},
	}

	t.server = &http.Server{
		Addr:      addr,
		Handler:   mux,
		TLSConfig: tlsConfig,
	}

	log.Info().Str("addr", addr).Msg("Starting WebSocket transport server")
	return t.server.ListenAndServeTLS("", "")
}

func (t *WSTransport) Stop() error {
	t.sessionsMu.Lock()
	for _, session := range t.sessions {
		session.Close()
	}
	t.sessionsMu.Unlock()

	if t.server != nil {
		return t.server.Close()
	}
	return nil
}

func (t *WSTransport) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Verify client certificate
	if len(r.TLS.PeerCertificates) == 0 {
		http.Error(w, "Client certificate required", http.StatusUnauthorized)
		return
	}

	clientCert := r.TLS.PeerCertificates[0]
	if err := t.verifyAgentCertificate(clientCert); err != nil {
		log.Warn().Err(err).Msg("Certificate verification failed")
		http.Error(w, "Invalid certificate", http.StatusUnauthorized)
		return
	}

	// Extract agent ID from certificate
	agentID := t.extractAgentID(clientCert)
	if agentID == "" {
		http.Error(w, "Invalid certificate: missing agent ID", http.StatusUnauthorized)
		return
	}

	// Upgrade to WebSocket
	conn, err := t.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Error().Err(err).Msg("WebSocket upgrade failed")
		return
	}

	// Create session
	sessionID := t.generateSessionID()
	ctx, cancel := context.WithCancel(r.Context())

	session := &Session{
		ID:           sessionID,
		AgentID:      agentID,
		Conn:         conn,
		Codec:        mux.NewFrameCodec(),
		Ctx:          nil, // Will be set below
		CancelFunc:   cancel,
		CreatedAt:    time.Now(),
		LastActivity: time.Now(),
	}

	// Set up send function
	session.Ctx = mux.NewSessionContext(sessionID, r.RemoteAddr,
		func(frame *mux.Frame) error { return session.Conn.WriteMessage(websocket.BinaryMessage, frame.Marshal()) },
		func() error { return conn.Close() },
	)

	// Set up heartbeat manager
	session.HeartbeatMgr = mux.NewHeartbeatManager(sessionID, 30*time.Second, 3, func(frame *mux.Frame) error {
		return session.Conn.WriteMessage(websocket.BinaryMessage, frame.Marshal())
	})
	session.HeartbeatMgr.SetOnMissedHeartbeat(func() {
		log.Warn().Uint64("session_id", sessionID).Str("agent_id", agentID).Msg("Heartbeat missed, closing session")
		session.Close()
	})
	session.HeartbeatMgr.Start()

	t.sessionsMu.Lock()
	t.sessions[sessionID] = session
	t.sessionsMu.Unlock()

	log.Info().Uint64("session_id", sessionID).Str("agent_id", agentID).Msg("New WebSocket session")

	// Start read loop
	go t.readLoop(session, ctx)

	// Wait for session to end
	<-ctx.Done()
	t.cleanupSession(sessionID)
}

func (t *WSTransport) readLoop(session *Session, ctx context.Context) {
	defer session.CancelFunc()

	for {
		select {
		case <-ctx.Done():
			return
		default:
			_, msg, err := session.Conn.ReadMessage()
			if err != nil {
				if !errors.Is(err, context.Canceled) {
					log.Error().Err(err).Uint64("session_id", session.ID).Msg("Read error")
				}
				return
			}

			session.LastActivity = time.Now()

			// Parse frame
			frame, err := session.Codec.Decode(bytes.NewReader(msg))
			if err != nil {
				log.Error().Err(err).Msg("Frame decode error")
				continue
			}

			// Handle heartbeat
			if frame.Header.MsgType == v1.FrameType_FRAME_TYPE_HEARTBEAT {
				session.HeartbeatMgr.OnHeartbeatReceived()
				// Send ack
				ack := &v1.HeartbeatAck{Sequence: frame.Header.SeqNum}
				ackFrame, _ := session.Codec.Encode(v1.FrameType_FRAME_TYPE_HEARTBEAT_ACK, session.ID, ack, 0)
				session.Conn.WriteMessage(websocket.BinaryMessage, ackFrame.Marshal())
				continue
			}

			if frame.Header.MsgType == v1.FrameType_FRAME_TYPE_HEARTBEAT_ACK {
				session.HeartbeatMgr.OnHeartbeatAckReceived(frame.Header.SeqNum)
				continue
			}

			// Route frame
			if err := t.frameRouter.Route(session.Ctx, frame); err != nil {
				log.Error().Err(err).Msg("Frame routing error")
			}
		}
	}
}

func (t *WSTransport) handleEnrollment(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Parse enrollment request
	var req v1.EnrollRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}

	challenge, err := t.enrollMgr.HandleEnrollRequest(r.Context(), &req)
	if err != nil {
		log.Error().Err(err).Msg("Enrollment request failed")
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	json.NewEncoder(w).Encode(challenge)
}

func (t *WSTransport) handleEnrollResponse(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var resp v1.EnrollResponse
	if err := json.NewDecoder(r.Body).Decode(&resp); err != nil {
		http.Error(w, "Invalid request", http.StatusBadRequest)
		return
	}

	result, err := t.enrollMgr.HandleEnrollResponse(r.Context(), &resp)
	if err != nil {
		log.Error().Err(err).Msg("Enrollment response failed")
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	json.NewEncoder(w).Encode(result)
}

func (t *WSTransport) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func (t *WSTransport) verifyAgentCertificate(cert *x509.Certificate) error {
	// Verify certificate chain against CA
	roots := x509.NewCertPool()
	roots.AddCert(t.caCert)
	opts := x509.VerifyOptions{
		Roots:         roots,
		Intermediates: x509.NewCertPool(),
		KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	_, err := cert.Verify(opts)
	return err
}

func (t *WSTransport) extractAgentID(cert *x509.Certificate) string {
	// Extract agent ID from certificate CN (format: agent-<agent_id>)
	cn := cert.Subject.CommonName
	if len(cn) > 6 && cn[:6] == "agent-" {
		return cn[6:]
	}
	return ""
}

func (t *WSTransport) generateSessionID() uint64 {
	return uint64(time.Now().UnixNano())
}

func (t *WSTransport) cleanupSession(sessionID uint64) {
	t.sessionsMu.Lock()
	defer t.sessionsMu.Unlock()

	if session, ok := t.sessions[sessionID]; ok {
		session.Close()
		delete(t.sessions, sessionID)
		log.Info().Uint64("session_id", sessionID).Str("agent_id", session.AgentID).Msg("Session cleaned up")
	}
}

func (s *Session) Close() error {
	if s.HeartbeatMgr != nil {
		s.HeartbeatMgr.Stop()
	}
	if s.CancelFunc != nil {
		s.CancelFunc()
	}
	if s.Conn != nil {
		return s.Conn.Close()
	}
	return nil
}

// Frame handlers

type HelloHandler struct {
	transport *WSTransport
}

func (h *HelloHandler) HandleFrame(ctx mux.Context, frame *mux.Frame) error {
	var hello v1.Hello
	if err := proto.Unmarshal(frame.Payload, &hello); err != nil {
		return err
	}

	// Verify hello signature
	if err := agent.VerifyAgentHello(&hello, h.transport.caCert); err != nil {
		log.Error().Err(err).Msg("Hello verification failed")
		return err
	}

	// Create welcome response
	serverSessionPubKey := make([]byte, 32)
	rand.Read(serverSessionPubKey)

	serverSigningKey := make(ed25519.PrivateKey, ed25519.PrivateKeySize)
	rand.Read(serverSigningKey)

	welcome, err := agent.CreateWelcome(frame.Header.SessionID, serverSessionPubKey, serverSigningKey)
	if err != nil {
		return err
	}

	_, _ = h.transport.frameCodec.Encode(v1.FrameType_FRAME_TYPE_WELCOME, frame.Header.SessionID, welcome, 0)
	return nil
}

type HeartbeatHandler struct{}

func (h *HeartbeatHandler) HandleFrame(ctx mux.Context, frame *mux.Frame) error {
	// Heartbeats are handled in readLoop
	return nil
}

type DesktopFrameHandler struct{}

func (h *DesktopFrameHandler) HandleFrame(ctx mux.Context, frame *mux.Frame) error {
	// Forward to web console
	log.Debug().Uint64("session_id", frame.Header.SessionID).Msg("Desktop frame received")
	return nil
}

type TerminalDataHandler struct{}

func (h *TerminalDataHandler) HandleFrame(ctx mux.Context, frame *mux.Frame) error {
	// Forward to web console
	log.Debug().Uint64("session_id", frame.Header.SessionID).Msg("Terminal data received")
	return nil
}

type FileTransferHandler struct{}

func (h *FileTransferHandler) HandleFrame(ctx mux.Context, frame *mux.Frame) error {
	log.Debug().Uint64("session_id", frame.Header.SessionID).Msg("File transfer frame received")
	return nil
}

type ProcessListHandler struct{}

func (h *ProcessListHandler) HandleFrame(ctx mux.Context, frame *mux.Frame) error {
	log.Debug().Uint64("session_id", frame.Header.SessionID).Msg("Process list frame received")
	return nil
}

type ScriptOutputHandler struct{}

func (h *ScriptOutputHandler) HandleFrame(ctx mux.Context, frame *mux.Frame) error {
	log.Debug().Uint64("session_id", frame.Header.SessionID).Msg("Script output frame received")
	return nil
}

type TelemetryHandler struct{}

func (h *TelemetryHandler) HandleFrame(ctx mux.Context, frame *mux.Frame) error {
	log.Debug().Uint64("session_id", frame.Header.SessionID).Msg("Telemetry frame received")
	return nil
}

func mustMarshal(msg proto.Message) []byte {
	data, _ := proto.Marshal(msg)
	return data
}
