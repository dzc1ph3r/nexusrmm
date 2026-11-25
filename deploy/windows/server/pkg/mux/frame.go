package mux

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"sync"
	"time"

	v1 "github.com/nexusrmm/nexusrmm/proto/gen/go/rmm"
	"google.golang.org/protobuf/proto"
)

const (
	// Magic bytes: "RMM"
	MagicByte0 = 0x52
	MagicByte1 = 0x4D
	MagicByte2 = 0x4D

	// Protocol version
	ProtocolVersion = 1

	// Flags
	FlagCompressed = 0x01
	FlagEncrypted  = 0x02
	FlagFragmented = 0x04

	// Header size: Magic(3) + Version(1) + Flags(1) + MsgType(2) + SessionID(8) + SeqNum(4) + PayloadLen(4) = 23
	HeaderSize     = 23
	ChecksumSize   = 4
	MaxPayloadSize = 16 << 20 // 16MB
)

var (
	ErrInvalidMagic    = errors.New("invalid magic bytes")
	ErrInvalidVersion  = errors.New("unsupported protocol version")
	ErrInvalidChecksum = errors.New("checksum mismatch")
	ErrPayloadTooLarge = errors.New("payload exceeds maximum size")
	ErrInvalidFrame    = errors.New("invalid frame format")
)

// FrameHeader represents the wire protocol frame header
type FrameHeader struct {
	Magic      [3]byte
	Version    uint8
	Flags      uint8
	MsgType    v1.FrameType
	SessionID  uint64
	SeqNum     uint32
	PayloadLen uint32
}

// Frame represents a complete wire protocol frame
type Frame struct {
	Header   FrameHeader
	Payload  []byte
	Checksum uint32
}

// FrameHandler defines the interface for handling frames
type FrameHandler interface {
	HandleFrame(ctx Context, frame *Frame) error
}

// Context provides context for frame processing
type Context interface {
	SessionID() uint64
	RemoteAddr() string
	Send(frame *Frame) error
	Close() error
}

// FrameCodec handles encoding/decoding of frames
type FrameCodec struct {
	mu       sync.Mutex
	seqNum   uint32
	compress Compressor
	encrypt  Encryptor
}

// Compressor interface for payload compression
type Compressor interface {
	Compress(data []byte) ([]byte, error)
	Decompress(data []byte) ([]byte, error)
}

// Encryptor interface for payload encryption
type Encryptor interface {
	Encrypt(data []byte) ([]byte, error)
	Decrypt(data []byte) ([]byte, error)
}

// NewFrameCodec creates a new frame codec
func NewFrameCodec() *FrameCodec {
	return &FrameCodec{
		seqNum: 1,
	}
}

// Encode encodes a protobuf message into a frame
func (fc *FrameCodec) Encode(msgType v1.FrameType, sessionID uint64, msg proto.Message, flags uint8) (*Frame, error) {
	payload, err := proto.Marshal(msg)
	if err != nil {
		return nil, err
	}

	// Apply compression if flag set
	if flags&FlagCompressed != 0 && fc.compress != nil {
		payload, err = fc.compress.Compress(payload)
		if err != nil {
			return nil, err
		}
	}

	// Apply encryption if flag set
	if flags&FlagEncrypted != 0 && fc.encrypt != nil {
		payload, err = fc.encrypt.Encrypt(payload)
		if err != nil {
			return nil, err
		}
	}

	if len(payload) > MaxPayloadSize {
		return nil, ErrPayloadTooLarge
	}

	fc.mu.Lock()
	seqNum := fc.seqNum
	fc.seqNum++
	fc.mu.Unlock()

	header := FrameHeader{
		Magic:      [3]byte{MagicByte0, MagicByte1, MagicByte2},
		Version:    ProtocolVersion,
		Flags:      flags,
		MsgType:    msgType,
		SessionID:  sessionID,
		SeqNum:     seqNum,
		PayloadLen: uint32(len(payload)),
	}

	frame := &Frame{
		Header:  header,
		Payload: payload,
	}

	frame.Checksum = fc.checksum(frame)
	return frame, nil
}

// Decode decodes a frame from a reader
func (fc *FrameCodec) Decode(r io.Reader) (*Frame, error) {
	// Read header
	headerBuf := make([]byte, HeaderSize)
	if _, err := io.ReadFull(r, headerBuf); err != nil {
		return nil, err
	}

	header, err := fc.parseHeader(headerBuf)
	if err != nil {
		return nil, err
	}

	// Read payload
	payload := make([]byte, header.PayloadLen)
	if header.PayloadLen > 0 {
		if _, err := io.ReadFull(r, payload); err != nil {
			return nil, err
		}
	}

	// Read checksum
	checksumBuf := make([]byte, ChecksumSize)
	if _, err := io.ReadFull(r, checksumBuf); err != nil {
		return nil, err
	}
	checksum := binary.BigEndian.Uint32(checksumBuf)

	frame := &Frame{
		Header:   header,
		Payload:  payload,
		Checksum: checksum,
	}

	// Verify checksum
	if fc.checksum(frame) != checksum {
		return nil, ErrInvalidChecksum
	}

	// Apply decryption if flag set
	if header.Flags&FlagEncrypted != 0 && fc.encrypt != nil {
		frame.Payload, err = fc.encrypt.Decrypt(frame.Payload)
		if err != nil {
			return nil, err
		}
	}

	// Apply decompression if flag set
	if header.Flags&FlagCompressed != 0 && fc.compress != nil {
		frame.Payload, err = fc.compress.Decompress(frame.Payload)
		if err != nil {
			return nil, err
		}
	}

	return frame, nil
}

// WriteTo writes a frame to a writer
func (f *Frame) WriteTo(w io.Writer) (int64, error) {
	var buf bytes.Buffer

	// Write header
	if err := binary.Write(&buf, binary.BigEndian, f.Header.Magic); err != nil {
		return 0, err
	}
	if err := binary.Write(&buf, binary.BigEndian, f.Header.Version); err != nil {
		return 0, err
	}
	if err := binary.Write(&buf, binary.BigEndian, f.Header.Flags); err != nil {
		return 0, err
	}
	if err := binary.Write(&buf, binary.BigEndian, uint16(f.Header.MsgType)); err != nil {
		return 0, err
	}
	if err := binary.Write(&buf, binary.BigEndian, f.Header.SessionID); err != nil {
		return 0, err
	}
	if err := binary.Write(&buf, binary.BigEndian, f.Header.SeqNum); err != nil {
		return 0, err
	}
	if err := binary.Write(&buf, binary.BigEndian, f.Header.PayloadLen); err != nil {
		return 0, err
	}

	// Write payload
	if f.Header.PayloadLen > 0 {
		if _, err := buf.Write(f.Payload); err != nil {
			return 0, err
		}
	}

	// Write checksum
	if err := binary.Write(&buf, binary.BigEndian, f.Checksum); err != nil {
		return 0, err
	}

	return buf.WriteTo(w)
}

func (fc *FrameCodec) parseHeader(buf []byte) (FrameHeader, error) {
	if len(buf) != HeaderSize {
		return FrameHeader{}, ErrInvalidFrame
	}

	// Check magic bytes
	if buf[0] != MagicByte0 || buf[1] != MagicByte1 || buf[2] != MagicByte2 {
		return FrameHeader{}, ErrInvalidMagic
	}

	// Check version
	if buf[3] != ProtocolVersion {
		return FrameHeader{}, ErrInvalidVersion
	}

	header := FrameHeader{
		Magic:   [3]byte{buf[0], buf[1], buf[2]},
		Version: buf[3],
		Flags:   buf[4],
		MsgType: v1.FrameType(binary.BigEndian.Uint16(buf[5:7])),
		SessionID: binary.BigEndian.Uint64(buf[7:15]),
		SeqNum:    binary.BigEndian.Uint32(buf[15:19]),
		PayloadLen: binary.BigEndian.Uint32(buf[19:23]),
	}

	return header, nil
}

func (fc *FrameCodec) checksum(frame *Frame) uint32 {
	// CRC32C (Castagnoli) of header + payload
	h := crc32.New(crc32.MakeTable(crc32.Castagnoli))

	// Write header fields
	h.Write(frame.Header.Magic[:])
	h.Write([]byte{frame.Header.Version})
	h.Write([]byte{frame.Header.Flags})
	binary.Write(h, binary.BigEndian, uint16(frame.Header.MsgType))
	binary.Write(h, binary.BigEndian, frame.Header.SessionID)
	binary.Write(h, binary.BigEndian, frame.Header.SeqNum)
	binary.Write(h, binary.BigEndian, frame.Header.PayloadLen)

	// Write payload
	if frame.Header.PayloadLen > 0 {
		h.Write(frame.Payload)
	}

	return h.Sum32()
}

// SetCompressor sets the compressor
func (fc *FrameCodec) SetCompressor(c Compressor) {
	fc.compress = c
}

// SetEncryptor sets the encryptor
func (fc *FrameCodec) SetEncryptor(e Encryptor) {
	fc.encrypt = e
}

// NextSeqNum returns the next sequence number
func (fc *FrameCodec) NextSeqNum() uint32 {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	seq := fc.seqNum
	fc.seqNum++
	return seq
}

// Marshal serializes a frame to bytes
func (f *Frame) Marshal() []byte {
	var buf bytes.Buffer
	f.WriteTo(&buf)
	return buf.Bytes()
}

// FrameRouter routes frames to appropriate handlers based on message type
type FrameRouter struct {
	handlers       map[v1.FrameType]FrameHandler
	mu             sync.RWMutex
	defaultHandler FrameHandler
}

// NewFrameRouter creates a new frame router
func NewFrameRouter() *FrameRouter {
	return &FrameRouter{
		handlers: make(map[v1.FrameType]FrameHandler),
	}
}

// Register registers a handler for a message type
func (fr *FrameRouter) Register(msgType v1.FrameType, handler FrameHandler) {
	fr.mu.Lock()
	defer fr.mu.Unlock()
	fr.handlers[msgType] = handler
}

// SetDefaultHandler sets the default handler for unregistered message types
func (fr *FrameRouter) SetDefaultHandler(handler FrameHandler) {
	fr.mu.Lock()
	defer fr.mu.Unlock()
	fr.defaultHandler = handler
}

// Route routes a frame to the appropriate handler
func (fr *FrameRouter) Route(ctx Context, frame *Frame) error {
	fr.mu.RLock()
	handler, ok := fr.handlers[frame.Header.MsgType]
	fr.mu.RUnlock()

	if !ok {
		if fr.defaultHandler != nil {
			return fr.defaultHandler.HandleFrame(ctx, frame)
		}
		return fmt.Errorf("no handler for message type %v", frame.Header.MsgType)
	}

	return handler.HandleFrame(ctx, frame)
}

// SessionContext implements Context for a session
type SessionContext struct {
	sessionID  uint64
	remoteAddr string
	sendFunc   func(*Frame) error
	closeFunc  func() error
}

func NewSessionContext(sessionID uint64, remoteAddr string, sendFunc func(*Frame) error, closeFunc func() error) *SessionContext {
	return &SessionContext{
		sessionID:  sessionID,
		remoteAddr: remoteAddr,
		sendFunc:   sendFunc,
		closeFunc:  closeFunc,
	}
}

func (sc *SessionContext) SessionID() uint64 {
	return sc.sessionID
}

func (sc *SessionContext) RemoteAddr() string {
	return sc.remoteAddr
}

func (sc *SessionContext) Send(frame *Frame) error {
	return sc.sendFunc(frame)
}

func (sc *SessionContext) Close() error {
	return sc.closeFunc()
}

// HeartbeatManager manages heartbeat state for a session
type HeartbeatManager struct {
	sessionID          uint64
	interval           time.Duration
	maxMissed          int
	missedCount        int
	lastReceived       time.Time
	lastSent           time.Time
	sendFunc           func(*Frame) error
	stopCh             chan struct{}
	mu                 sync.Mutex
	onMissedHeartbeat  func()
}

// NewHeartbeatManager creates a new heartbeat manager
func NewHeartbeatManager(sessionID uint64, interval time.Duration, maxMissed int, sendFunc func(*Frame) error) *HeartbeatManager {
	return &HeartbeatManager{
		sessionID:     sessionID,
		interval:      interval,
		maxMissed:     maxMissed,
		sendFunc:      sendFunc,
		stopCh:        make(chan struct{}),
		lastReceived:  time.Now(),
	}
}

// Start starts the heartbeat loop
func (hm *HeartbeatManager) Start() {
	go hm.run()
}

// Stop stops the heartbeat loop
func (hm *HeartbeatManager) Stop() {
	close(hm.stopCh)
}

func (hm *HeartbeatManager) run() {
	ticker := time.NewTicker(hm.interval)
	defer ticker.Stop()

	for {
		select {
		case <-hm.stopCh:
			return
		case <-ticker.C:
			hm.sendHeartbeat()
			hm.checkMissed()
		}
	}
}

func (hm *HeartbeatManager) sendHeartbeat() {
	hm.mu.Lock()
	defer hm.mu.Unlock()

	hb := &v1.Heartbeat{
		Timestamp: time.Now().UnixMilli(),
		Sequence:  uint32(time.Now().UnixNano()),
	}

	frame, err := NewFrameCodec().Encode(v1.FrameType_FRAME_TYPE_HEARTBEAT, hm.sessionID, hb, 0)
	if err != nil {
		return
	}

	if err := hm.sendFunc(frame); err != nil {
		return
	}

	hm.lastSent = time.Now()
}

func (hm *HeartbeatManager) checkMissed() {
	hm.mu.Lock()
	defer hm.mu.Unlock()

	if time.Since(hm.lastReceived) > hm.interval*time.Duration(hm.maxMissed) {
		hm.missedCount++
		if hm.missedCount >= hm.maxMissed && hm.onMissedHeartbeat != nil {
			hm.onMissedHeartbeat()
		}
	}
}

// OnHeartbeatReceived should be called when a heartbeat is received
func (hm *HeartbeatManager) OnHeartbeatReceived() {
	hm.mu.Lock()
	defer hm.mu.Unlock()
	hm.lastReceived = time.Now()
	hm.missedCount = 0
}

// OnHeartbeatAckReceived should be called when a heartbeat ack is received
func (hm *HeartbeatManager) OnHeartbeatAckReceived(seq uint32) {
	hm.mu.Lock()
	defer hm.mu.Unlock()
	// Could verify sequence matches
}

// SetOnMissedHeartbeat sets the callback for missed heartbeats
func (hm *HeartbeatManager) SetOnMissedHeartbeat(fn func()) {
	hm.mu.Lock()
	defer hm.mu.Unlock()
	hm.onMissedHeartbeat = fn
}
