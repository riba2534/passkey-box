package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

const (
	// TokenPrefix starts every API token secret.
	TokenPrefix = "pkb_"
	// tokenPrefixLen is how much of a secret is kept in clear for display.
	tokenPrefixLen = 12
	// MaxTokensPerUser caps the API tokens one user can hold.
	MaxTokensPerUser = 50
	// tokenTouchInterval throttles last_used_at writes for busy tokens.
	tokenTouchInterval = time.Minute
)

// APIToken is an API token. Only the SHA-256 of its secret is stored.
type APIToken struct {
	ID         int64
	UserID     int64
	Name       string
	Prefix     string
	ReadOnly   bool
	CreatedAt  time.Time
	ExpiresAt  *time.Time
	LastUsedAt *time.Time
}

func hashToken(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

func newTokenSecret() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return TokenPrefix + base64.RawURLEncoding.EncodeToString(buf), nil
}

const tokenColumns = `id, user_id, name, prefix, read_only, created_at, expires_at, last_used_at`

func scanToken(r rowScanner) (APIToken, error) {
	var (
		t                 APIToken
		created           int64
		expires, lastUsed sql.NullInt64
	)
	if err := r.Scan(&t.ID, &t.UserID, &t.Name, &t.Prefix, &t.ReadOnly, &created, &expires, &lastUsed); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return APIToken{}, ErrNotFound
		}
		return APIToken{}, err
	}
	t.CreatedAt = fromMillis(created)
	t.ExpiresAt = fromNullMillis(expires)
	t.LastUsedAt = fromNullMillis(lastUsed)
	return t, nil
}

func nullMillis(t *time.Time) sql.NullInt64 {
	if t == nil {
		return sql.NullInt64{}
	}
	return sql.NullInt64{Int64: toMillis(*t), Valid: true}
}

// CreateToken issues an API token for the user and returns it with its secret,
// which is not stored and cannot be shown again. A nil expiresAt never
// expires. Holding MaxTokensPerUser tokens already is an *InvalidError.
func (s *Store) CreateToken(ctx context.Context, actor Actor, userID int64, name string, readOnly bool, expiresAt *time.Time, now time.Time) (APIToken, string, error) {
	secret, err := newTokenSecret()
	if err != nil {
		return APIToken{}, "", err
	}
	var token APIToken
	err = s.inTx(ctx, false, func(tx *sql.Tx) error {
		user, err := resolveUser(ctx, tx, UserKey{ID: userID})
		if err != nil {
			return err
		}
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM api_tokens WHERE user_id = ?`, userID).Scan(&n); err != nil {
			return err
		}
		if n >= MaxTokensPerUser {
			return Invalid("a user can hold at most %d API tokens", MaxTokensPerUser)
		}
		res, err := tx.ExecContext(ctx, `INSERT INTO api_tokens
			(user_id, name, token_hash, prefix, read_only, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			userID, name, hashToken(secret), secret[:tokenPrefixLen], readOnly, toMillis(now), nullMillis(expiresAt))
		if err != nil {
			return err
		}
		id, err := res.LastInsertId()
		if err != nil {
			return err
		}
		if token, err = scanToken(tx.QueryRowContext(ctx, `SELECT `+tokenColumns+` FROM api_tokens WHERE id = ?`, id)); err != nil {
			return err
		}
		subject := user.Brief()
		return writeAudit(ctx, tx, now, actor, AuditEntry{Action: "token.create", Subject: &subject,
			Detail: map[string]any{"name": name, "read_only": readOnly}})
	})
	if err != nil {
		return APIToken{}, "", err
	}
	return token, secret, nil
}

// ListTokens returns the user's API tokens, newest first.
func (s *Store) ListTokens(ctx context.Context, userID int64) ([]APIToken, error) {
	return queryRows(ctx, s.db, scanToken, `SELECT `+tokenColumns+` FROM api_tokens WHERE user_id = ? ORDER BY id DESC`, userID)
}

// DeleteToken revokes one of the user's API tokens.
func (s *Store) DeleteToken(ctx context.Context, actor Actor, userID, tokenID int64, now time.Time) error {
	return s.inTx(ctx, false, func(tx *sql.Tx) error {
		token, err := scanToken(tx.QueryRowContext(ctx,
			`SELECT `+tokenColumns+` FROM api_tokens WHERE id = ? AND user_id = ?`, tokenID, userID))
		if err != nil {
			return err
		}
		user, err := resolveUser(ctx, tx, UserKey{ID: userID})
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM api_tokens WHERE id = ?`, tokenID); err != nil {
			return err
		}
		subject := user.Brief()
		return writeAudit(ctx, tx, now, actor, AuditEntry{Action: "token.revoke", Subject: &subject,
			Detail: map[string]any{"name": token.Name, "read_only": token.ReadOnly}})
	})
}

// TokenUser returns the user owning an unexpired token with the given secret,
// and records the use. Unknown, malformed and expired tokens are ErrNotFound.
func (s *Store) TokenUser(ctx context.Context, secret string, now time.Time) (User, APIToken, error) {
	if !strings.HasPrefix(secret, TokenPrefix) || len(secret) < tokenPrefixLen {
		return User{}, APIToken{}, ErrNotFound
	}
	token, err := scanToken(s.db.QueryRowContext(ctx,
		`SELECT `+tokenColumns+` FROM api_tokens WHERE token_hash = ?`, hashToken(secret)))
	if err != nil {
		return User{}, APIToken{}, err
	}
	if token.ExpiresAt != nil && !now.Before(*token.ExpiresAt) {
		return User{}, APIToken{}, ErrNotFound
	}
	user, err := s.GetUser(ctx, token.UserID)
	if err != nil {
		return User{}, APIToken{}, err
	}
	if token.LastUsedAt == nil || now.Sub(*token.LastUsedAt) >= tokenTouchInterval {
		if _, err := s.db.ExecContext(ctx, `UPDATE api_tokens SET last_used_at = ? WHERE id = ?`, toMillis(now), token.ID); err != nil {
			return User{}, APIToken{}, err
		}
		t := fromMillis(toMillis(now))
		token.LastUsedAt = &t
	}
	return user, token, nil
}

// RevokeAccess deletes all sessions and API tokens of the user. The password,
// and with it HTTP Basic access, is unchanged.
func (s *Store) RevokeAccess(ctx context.Context, actor Actor, userID int64, now time.Time) (sessions, tokens int, err error) {
	err = s.inTx(ctx, false, func(tx *sql.Tx) error {
		user, err := resolveUser(ctx, tx, UserKey{ID: userID})
		if err != nil {
			return err
		}
		count := func(query string) (int, error) {
			res, err := tx.ExecContext(ctx, query, userID)
			if err != nil {
				return 0, err
			}
			n, err := res.RowsAffected()
			return int(n), err
		}
		if sessions, err = count(`DELETE FROM sessions WHERE user_id = ?`); err != nil {
			return err
		}
		if tokens, err = count(`DELETE FROM api_tokens WHERE user_id = ?`); err != nil {
			return err
		}
		subject := user.Brief()
		return writeAudit(ctx, tx, now, actor, AuditEntry{Action: "user.revoke_sessions", Subject: &subject,
			Detail: map[string]any{"sessions": sessions, "tokens": tokens}})
	})
	return sessions, tokens, err
}
