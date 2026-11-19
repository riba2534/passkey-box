// Package store persists users, sessions and passkey credentials in SQLite.
package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
	_ "modernc.org/sqlite" // registers the "sqlite" driver
)

var (
	// ErrNotFound reports a missing user, session or credential.
	ErrNotFound = errors.New("not found")
	// ErrConflict reports a duplicate username or credential ID.
	ErrConflict = errors.New("conflict")
	// ErrBadPassword reports a password that does not match.
	ErrBadPassword = errors.New("wrong password")
)

// MaxUsernameLen is the maximum username length in characters after trimming.
const MaxUsernameLen = 64

const schema = `
CREATE TABLE IF NOT EXISTS users (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	username      TEXT    NOT NULL,
	username_key  TEXT    NOT NULL UNIQUE,
	password_hash TEXT    NOT NULL,
	is_admin      INTEGER NOT NULL DEFAULT 0,
	created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
	token      TEXT    PRIMARY KEY,
	user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS credentials (
	seq               INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	id                TEXT    NOT NULL,
	rp_id             TEXT    NOT NULL,
	rp_id_key         TEXT    NOT NULL,
	rp_name           TEXT    NOT NULL DEFAULT '',
	user_handle       TEXT    NOT NULL,
	user_name         TEXT    NOT NULL DEFAULT '',
	user_display_name TEXT    NOT NULL DEFAULT '',
	alg               INTEGER NOT NULL,
	private_key       TEXT    NOT NULL,
	public_key        TEXT    NOT NULL DEFAULT '',
	sign_count        INTEGER NOT NULL DEFAULT 0,
	label             TEXT    NOT NULL DEFAULT '',
	origin            TEXT    NOT NULL DEFAULT '',
	created_at        INTEGER NOT NULL,
	last_used_at      INTEGER,
	use_count         INTEGER NOT NULL DEFAULT 0,
	UNIQUE (user_id, id)
);
CREATE INDEX IF NOT EXISTS credentials_user_rp ON credentials(user_id, rp_id_key, user_handle);
`

// User is an account together with its credential statistics.
type User struct {
	ID              int64
	Username        string
	IsAdmin         bool
	CreatedAt       time.Time
	CredentialCount int
	LastUsedAt      *time.Time
}

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

// Store is a SQLite-backed repository. It is safe for concurrent use.
type Store struct {
	db *sql.DB

	// PasswordCost is the bcrypt cost used for new password hashes.
	PasswordCost int

	// verified remembers password checks that already succeeded, keyed by
	// sha256(username key, password) and mapped to the bcrypt hash they matched.
	// The extension sends Basic credentials on every request; this keeps it from
	// paying a bcrypt comparison each time. A password change alters the stored
	// hash, so stale entries never match again.
	mu       sync.Mutex
	verified map[[32]byte]string
}

const maxVerifiedEntries = 1024

// Open opens (and if needed creates) the database at path. The parent
// directory is created when missing.
func Open(path string) (*Store, error) {
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("create database directory: %w", err)
		}
	}
	q := url.Values{}
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "temp_store(memory)")
	db, err := sql.Open("sqlite", path+"?"+q.Encode())
	if err != nil {
		return nil, err
	}
	// A single connection serialises all access, which keeps SQLite free of
	// SQLITE_BUSY errors. The workload is tiny, so this costs nothing.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("initialise schema: %w", err)
	}
	return &Store{db: db, PasswordCost: bcrypt.DefaultCost, verified: map[[32]byte]string{}}, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

// NormalizeUsername trims the username and checks its length. It returns the
// display form and the case-insensitive lookup key.
func NormalizeUsername(username string) (display, key string, ok bool) {
	display = strings.TrimSpace(username)
	n := utf8.RuneCountInString(display)
	if n < 1 || n > MaxUsernameLen {
		return "", "", false
	}
	return display, strings.ToLower(display), true
}

func usernameKey(username string) string {
	return strings.ToLower(strings.TrimSpace(username))
}

func toMillis(t time.Time) int64 { return t.UnixMilli() }

func fromMillis(ms int64) time.Time { return time.UnixMilli(ms).UTC() }

func fromNullMillis(v sql.NullInt64) *time.Time {
	if !v.Valid {
		return nil
	}
	t := fromMillis(v.Int64)
	return &t
}

func (s *Store) hash(password string) (string, error) {
	h, err := bcrypt.GenerateFromPassword([]byte(password), s.PasswordCost)
	if err != nil {
		return "", err
	}
	return string(h), nil
}

func (s *Store) passwordMatches(key, password, hash string) bool {
	sum := sha256.Sum256([]byte(key + "\x00" + password))
	s.mu.Lock()
	cached, ok := s.verified[sum]
	s.mu.Unlock()
	if ok && cached == hash {
		return true
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return false
	}
	s.mu.Lock()
	if len(s.verified) >= maxVerifiedEntries {
		clear(s.verified)
	}
	s.verified[sum] = hash
	s.mu.Unlock()
	return true
}

const userColumns = `u.id, u.username, u.is_admin, u.created_at,
	(SELECT COUNT(*) FROM credentials c WHERE c.user_id = u.id),
	(SELECT MAX(c.last_used_at) FROM credentials c WHERE c.user_id = u.id)`

type rowScanner interface{ Scan(dest ...any) error }

func scanUser(r rowScanner) (User, error) {
	var (
		u        User
		created  int64
		lastUsed sql.NullInt64
	)
	if err := r.Scan(&u.ID, &u.Username, &u.IsAdmin, &created, &u.CredentialCount, &lastUsed); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return User{}, ErrNotFound
		}
		return User{}, err
	}
	u.CreatedAt = fromMillis(created)
	u.LastUsedAt = fromNullMillis(lastUsed)
	return u, nil
}

// CreateUser creates an account. The username must already be valid
// (see NormalizeUsername); duplicates (case-insensitive) return ErrConflict.
func (s *Store) CreateUser(ctx context.Context, username, password string, isAdmin bool, now time.Time) (User, error) {
	display, key, ok := NormalizeUsername(username)
	if !ok {
		return User{}, fmt.Errorf("invalid username %q", username)
	}
	hash, err := s.hash(password)
	if err != nil {
		return User{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback()
	var exists int
	err = tx.QueryRowContext(ctx, `SELECT 1 FROM users WHERE username_key = ?`, key).Scan(&exists)
	if err == nil {
		return User{}, ErrConflict
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return User{}, err
	}
	res, err := tx.ExecContext(ctx,
		`INSERT INTO users (username, username_key, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?)`,
		display, key, hash, isAdmin, toMillis(now))
	if err != nil {
		return User{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, err
	}
	return s.GetUser(ctx, id)
}

// GetUser returns the user with the given ID.
func (s *Store) GetUser(ctx context.Context, id int64) (User, error) {
	return scanUser(s.db.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users u WHERE u.id = ?`, id))
}

// ListUsers returns all users ordered by ID.
func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+userColumns+` FROM users u ORDER BY u.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	users := []User{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

// Authenticate checks a username (case-insensitive) and password. It returns
// ErrBadPassword for an unknown user or a wrong password.
func (s *Store) Authenticate(ctx context.Context, username, password string) (User, error) {
	key := usernameKey(username)
	var (
		id   int64
		hash string
	)
	err := s.db.QueryRowContext(ctx, `SELECT id, password_hash FROM users WHERE username_key = ?`, key).Scan(&id, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrBadPassword
	}
	if err != nil {
		return User{}, err
	}
	if !s.passwordMatches(key, password, hash) {
		return User{}, ErrBadPassword
	}
	return s.GetUser(ctx, id)
}

// CheckPassword reports ErrBadPassword when password is not the user's password.
func (s *Store) CheckPassword(ctx context.Context, id int64, password string) error {
	var key, hash string
	err := s.db.QueryRowContext(ctx, `SELECT username_key, password_hash FROM users WHERE id = ?`, id).Scan(&key, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if !s.passwordMatches(key, password, hash) {
		return ErrBadPassword
	}
	return nil
}

// SetPassword replaces the user's password. Existing sessions stay valid.
func (s *Store) SetPassword(ctx context.Context, id int64, password string) error {
	hash, err := s.hash(password)
	if err != nil {
		return err
	}
	return s.execOne(ctx, `UPDATE users SET password_hash = ? WHERE id = ?`, hash, id)
}

// SetAdmin grants or revokes administrator rights.
func (s *Store) SetAdmin(ctx context.Context, id int64, isAdmin bool) error {
	return s.execOne(ctx, `UPDATE users SET is_admin = ? WHERE id = ?`, isAdmin, id)
}

// DeleteUser removes the user together with its sessions and credentials.
func (s *Store) DeleteUser(ctx context.Context, id int64) error {
	return s.execOne(ctx, `DELETE FROM users WHERE id = ?`, id)
}

// EnsureAdmin makes sure the named user exists and is an administrator. A new
// user gets the given password; an existing user keeps its password.
func (s *Store) EnsureAdmin(ctx context.Context, username, password string, now time.Time) (created bool, err error) {
	_, key, ok := NormalizeUsername(username)
	if !ok {
		return false, fmt.Errorf("invalid admin username %q", username)
	}
	var id int64
	err = s.db.QueryRowContext(ctx, `SELECT id FROM users WHERE username_key = ?`, key).Scan(&id)
	switch {
	case err == nil:
		return false, s.SetAdmin(ctx, id, true)
	case errors.Is(err, sql.ErrNoRows):
		_, err = s.CreateUser(ctx, username, password, true, now)
		return err == nil, err
	default:
		return false, err
	}
}

// CreateSession stores a login session.
func (s *Store) CreateSession(ctx context.Context, token string, userID int64, now, expires time.Time) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
		token, userID, toMillis(now), toMillis(expires))
	return err
}

// SessionUser returns the user owning an unexpired session.
func (s *Store) SessionUser(ctx context.Context, token string, now time.Time) (User, error) {
	var userID, expires int64
	err := s.db.QueryRowContext(ctx, `SELECT user_id, expires_at FROM sessions WHERE token = ?`, token).Scan(&userID, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, err
	}
	if toMillis(now) >= expires {
		_ = s.DeleteSession(ctx, token)
		return User{}, ErrNotFound
	}
	return s.GetUser(ctx, userID)
}

// DeleteSession removes a session; a missing session is not an error.
func (s *Store) DeleteSession(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token = ?`, token)
	return err
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
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	creds := []Credential{}
	for rows.Next() {
		c, err := scanCredential(rows)
		if err != nil {
			return nil, err
		}
		creds = append(creds, c)
	}
	return creds, rows.Err()
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
	err = tx.QueryRowContext(ctx, `SELECT 1 FROM credentials WHERE user_id = ? AND id = ?`, userID, c.ID).Scan(&exists)
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

// execOne runs a statement that must affect at least one row.
func (s *Store) execOne(ctx context.Context, query string, args ...any) error {
	res, err := s.db.ExecContext(ctx, query, args...)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
