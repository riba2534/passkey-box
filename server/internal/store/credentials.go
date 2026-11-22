package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// Credential is a stored passkey.
type Credential struct {
	ID              string
	RPID            string
	RPName          string
	UserHandle      string
	UserName        string
	UserDisplayName string
	Alg             int
	PrivateKey      string
	PublicKey       string
	SignCount       int64
	Label           string
	Origin          string
	CreatedAt       time.Time
	LastUsedAt      *time.Time
	UseCount        int64
}

const credentialColumns = `id, rp_id, rp_name, user_handle, user_name, user_display_name, alg,
	private_key, public_key, sign_count, label, origin, created_at, last_used_at, use_count`

func scanCredential(r rowScanner) (Credential, error) {
	var (
		c        Credential
		created  int64
		lastUsed sql.NullInt64
	)
	err := r.Scan(&c.ID, &c.RPID, &c.RPName, &c.UserHandle, &c.UserName, &c.UserDisplayName, &c.Alg,
		&c.PrivateKey, &c.PublicKey, &c.SignCount, &c.Label, &c.Origin, &created, &lastUsed, &c.UseCount)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Credential{}, ErrNotFound
		}
		return Credential{}, err
	}
	c.CreatedAt = fromMillis(created)
	c.LastUsedAt = fromNullMillis(lastUsed)
	return c, nil
}

// ListCredentials returns the user's credentials, newest first. A non-empty
// rpID keeps only credentials whose rp_id equals it case-insensitively.
func (s *Store) ListCredentials(ctx context.Context, userID int64, rpID string) ([]Credential, error) {
	query := `SELECT ` + credentialColumns + ` FROM credentials WHERE user_id = ?`
	args := []any{userID}
	if rpID != "" {
		query += ` AND rp_id_key = ?`
		args = append(args, strings.ToLower(rpID))
	}
	query += ` ORDER BY created_at DESC, seq DESC`
	return queryRows(ctx, s.db, scanCredential, query, args...)
}

// GetCredential returns one of the user's credentials.
func (s *Store) GetCredential(ctx context.Context, userID int64, id string) (Credential, error) {
	return scanCredential(s.db.QueryRowContext(ctx,
		`SELECT `+credentialColumns+` FROM credentials WHERE user_id = ? AND id = ?`, userID, id))
}

// SaveCredential stores a new credential for the user. Existing credentials
// with the same rp_id (case-insensitive) and user_handle are replaced, the way
// an authenticator overwrites a discoverable credential for the same account.
// If the ID is still taken by another credential, nothing changes and
// ErrConflict is returned. Statistics on c are ignored.
func (s *Store) SaveCredential(ctx context.Context, userID int64, c Credential, now time.Time) (Credential, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Credential{}, err
	}
	defer tx.Rollback()
	rpKey := strings.ToLower(c.RPID)
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM credentials WHERE user_id = ? AND rp_id_key = ? AND user_handle = ?`,
		userID, rpKey, c.UserHandle); err != nil {
		return Credential{}, err
	}
	var exists int
	// IDs are unique across all users (schema 1).
	err = tx.QueryRowContext(ctx, `SELECT 1 FROM credentials WHERE id = ?`, c.ID).Scan(&exists)
	if err == nil {
		return Credential{}, ErrConflict
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Credential{}, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO credentials
		(user_id, id, rp_id, rp_id_key, rp_name, user_handle, user_name, user_display_name, alg,
		 private_key, public_key, sign_count, label, origin, created_at, last_used_at, use_count)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)`,
		userID, c.ID, c.RPID, rpKey, c.RPName, c.UserHandle, c.UserName, c.UserDisplayName, c.Alg,
		c.PrivateKey, c.PublicKey, c.SignCount, c.Label, c.Origin, toMillis(now))
	if err != nil {
		return Credential{}, err
	}
	if err := tx.Commit(); err != nil {
		return Credential{}, err
	}
	return s.GetCredential(ctx, userID, c.ID)
}

// SetCredentialLabel changes the user-visible note of a credential.
func (s *Store) SetCredentialLabel(ctx context.Context, userID int64, id, label string) (Credential, error) {
	if err := s.execOne(ctx, `UPDATE credentials SET label = ? WHERE user_id = ? AND id = ?`, label, userID, id); err != nil {
		return Credential{}, err
	}
	return s.GetCredential(ctx, userID, id)
}

// MarkCredentialUsed increments the use counter and records the time.
func (s *Store) MarkCredentialUsed(ctx context.Context, userID int64, id string, now time.Time) error {
	return s.execOne(ctx,
		`UPDATE credentials SET use_count = use_count + 1, last_used_at = ? WHERE user_id = ? AND id = ?`,
		toMillis(now), userID, id)
}

// DeleteCredential removes one of the user's credentials.
func (s *Store) DeleteCredential(ctx context.Context, userID int64, id string) error {
	return s.execOne(ctx, `DELETE FROM credentials WHERE user_id = ? AND id = ?`, userID, id)
}
