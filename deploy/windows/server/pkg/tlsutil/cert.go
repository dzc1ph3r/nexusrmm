package tlsutil

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/crypto/ed25519"
)

// CA holds a certificate authority
type CA struct {
	Cert *x509.Certificate
	Key  interface{} // *rsa.PrivateKey, *ecdsa.PrivateKey, or ed25519.PrivateKey
}

// NewCA creates a new certificate authority
func NewCA(commonName string, validFor time.Duration) (*CA, error) {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}

	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject: pkix.Name{
			CommonName:   commonName,
			Organization: []string{"Nexus RMM"},
		},
		NotBefore:             time.Now(),
		NotAfter:              time.Now().Add(validFor),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
		MaxPathLen:            1,
	}

	certDER, err := x509.CreateCertificate(rand.Reader, &template, &template, key.Public(), key)
	if err != nil {
		return nil, err
	}

	cert, err := x509.ParseCertificate(certDER)
	if err != nil {
		return nil, err
	}

	return &CA{
		Cert: cert,
		Key:  key,
	}, nil
}

// LoadCA loads a CA from PEM files
func LoadCA(certFile, keyFile string) (*CA, error) {
	certPEM, err := os.ReadFile(certFile)
	if err != nil {
		return nil, err
	}
	keyPEM, err := os.ReadFile(keyFile)
	if err != nil {
		return nil, err
	}

	block, _ := pem.Decode(certPEM)
	if block == nil {
		return nil, ErrInvalidPEM
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, err
	}

	block, _ = pem.Decode(keyPEM)
	if block == nil {
		return nil, ErrInvalidPEM
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}

	return &CA{Cert: cert, Key: key}, nil
}

// SaveCA saves a CA to PEM files
func (ca *CA) SaveCA(certFile, keyFile string) error {
	if err := os.MkdirAll(filepath.Dir(certFile), 0700); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(keyFile), 0700); err != nil {
		return err
	}

	certPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "CERTIFICATE",
		Bytes: ca.Cert.Raw,
	})
	if err := os.WriteFile(certFile, certPEM, 0644); err != nil {
		return err
	}

	keyBytes, err := x509.MarshalPKCS8PrivateKey(ca.Key)
	if err != nil {
		return err
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "PRIVATE KEY",
		Bytes: keyBytes,
	})
	if err := os.WriteFile(keyFile, keyPEM, 0600); err != nil {
		return err
	}

	return nil
}

// IssueCertificate issues a new certificate signed by the CA
func (ca *CA) IssueCertificate(template *x509.Certificate, pubKey interface{}) (*x509.Certificate, []byte, error) {
	if template.SerialNumber == nil {
		template.SerialNumber = big.NewInt(time.Now().UnixNano())
	}
	if template.NotBefore.IsZero() {
		template.NotBefore = time.Now()
	}
	if template.NotAfter.IsZero() {
		template.NotAfter = time.Now().Add(90 * 24 * time.Hour)
	}

	certDER, err := x509.CreateCertificate(rand.Reader, template, ca.Cert, pubKey, ca.Key)
	if err != nil {
		return nil, nil, err
	}

	cert, err := x509.ParseCertificate(certDER)
	if err != nil {
		return nil, nil, err
	}

	return cert, certDER, nil
}

// IssueAgentCertificate issues a certificate for an agent
func (ca *CA) IssueAgentCertificate(agentID, tenantID string, ed25519PubKey ed25519.PublicKey, validFor time.Duration) (*x509.Certificate, []byte, error) {
	template := &x509.Certificate{
		Subject: pkix.Name{
			CommonName:   "agent-" + agentID,
			Organization: []string{"Nexus RMM"},
			OrganizationalUnit: []string{"tenant-" + tenantID},
		},
		NotBefore:   time.Now(),
		NotAfter:    time.Now().Add(validFor),
		KeyUsage:    x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment | x509.KeyUsageKeyAgreement,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth},
		IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback},
		DNSNames:    []string{"localhost", "agent-" + agentID + ".nexusrmm.internal"},
	}

	return ca.IssueCertificate(template, ed25519PubKey)
}

// IssueServerCertificate issues a certificate for the server
func (ca *CA) IssueServerCertificate(domains []string, validFor time.Duration) (*x509.Certificate, []byte, error) {
	template := &x509.Certificate{
		Subject: pkix.Name{
			CommonName:   domains[0],
			Organization: []string{"Nexus RMM"},
		},
		NotBefore:   time.Now(),
		NotAfter:    time.Now().Add(validFor),
		KeyUsage:    x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment | x509.KeyUsageKeyAgreement,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		DNSNames:    domains,
		IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback},
	}

	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, err
	}

	cert, certDER, err := ca.IssueCertificate(template, key.Public())
	if err != nil {
		return nil, nil, err
	}

	keyBytes, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, nil, err
	}

	keyPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "PRIVATE KEY",
		Bytes: keyBytes,
	})

	return cert, append(certDER, keyPEM...), nil
}

// GenerateEd25519KeyPair generates a new Ed25519 key pair
func GenerateEd25519KeyPair() (ed25519.PublicKey, ed25519.PrivateKey, error) {
	return ed25519.GenerateKey(rand.Reader)
}

// VerifyEd25519Signature verifies an Ed25519 signature
func VerifyEd25519Signature(pubKey ed25519.PublicKey, message, signature []byte) bool {
	return ed25519.Verify(pubKey, message, signature)
}

// SignEd25519 signs a message with an Ed25519 private key
func SignEd25519(privKey ed25519.PrivateKey, message []byte) []byte {
	return ed25519.Sign(privKey, message)
}

// CertificateFingerprint returns the SHA256 fingerprint of a certificate
func CertificateFingerprint(cert *x509.Certificate) string {
	sum := sha256.Sum256(cert.Raw)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// ParseCertificatePEM parses a PEM-encoded certificate
func ParseCertificatePEM(pemData []byte) (*x509.Certificate, error) {
	block, _ := pem.Decode(pemData)
	if block == nil {
		return nil, ErrInvalidPEM
	}
	return x509.ParseCertificate(block.Bytes)
}

// ParsePrivateKeyPEM parses a PEM-encoded private key
func ParsePrivateKeyPEM(pemData []byte) (interface{}, error) {
	block, _ := pem.Decode(pemData)
	if block == nil {
		return nil, ErrInvalidPEM
	}
	return x509.ParsePKCS8PrivateKey(block.Bytes)
}

// ErrInvalidPEM is returned when PEM decoding fails
var ErrInvalidPEM = errors.New("invalid PEM data")
