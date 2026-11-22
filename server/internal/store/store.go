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
	// ErrForbidden reports an operation the caller may not perform on a
	// resource it can see, for example a share recipient deleting for everyone.
	ErrForbidden = errors.New("forbidden")
)

// MaxUsernameLen is the maximum username length in characters after trimming.
const MaxUsernameLen = 64

// schema is the version 0 schema, which databases created before migrations
// existed have. Never change it: later versions are added in migrate.go.
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
	ID       int64
	Username string
	IsAdmin  bool
	// Disabled users cannot sign in with any method.
	Disabled bool
	// Note is the administrators' note about the user.
	Note      string
	CreatedAt time.Time
	// CredentialCount counts the credentials the user owns.
	CredentialCount int
	// SharedInCount counts credentials other users share with the user.
	SharedInCount int
	// SharedOutCount counts owned credentials shared with at least one user.
	SharedOutCount int
	// LastUsedAt is the latest use of an owned credential.
	LastUsedAt *time.Time
}

// UserBrief names a user: an owner, a share recipient or an audit party.
type UserBrief struct {
	ID       int64
	Username string
}

// Brief returns the user's ID and name.
func (u User) Brief() UserBrief { return UserBrief{ID: u.ID, Username: u.Username} }

// UserKey refers to a user by ID or, when ID is 0, by username
// (case-insensitive).
type UserKey struct {
	ID       int64
	Username string
}

// Store is a SQLite-backed repository. It is safe for concurrent use.
type Store struct {
	db *sql.DB

	// Migration is what Open did to the schema.
	Migration Migration

	// PasswordCost is the bcrypt cost used for new password hashes.
	PasswordCost int

	// verified remembers password checks that already succeeded, keyed by
	// sha256(username key, password) and mapped to the bcrypt hash they matched.
	// The extension sends Basic credentials on every request; this keeps it from
	// paying a bcrypt comparison each time. A password change alters the stored
	// hash, so stale entries never match again.
	mu       sync.Mutex
	verified map[[32]byte]string

	// reservedKey is the lookup key of the bootstrap administrator's name
	// (EnsureAdmin). Start-up makes whoever holds that name an administrator,
	// so nobody may rename to or from it, or register it.
	reservedKey string
}

// ReservedUsername reports whether name is the bootstrap administrator's
// (PKB_ADMIN_USERNAME), which self-registration must not take.
func (s *Store) ReservedUsername(name string) bool {
	_, key, ok := NormalizeUsername(name)
	return ok && s.reservedKey != "" && key == s.reservedKey
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
	ctx := context.Background()
	var existed bool
	if err := db.QueryRowContext(ctx,
		`SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users')`).Scan(&existed); err != nil {
		db.Close()
		return nil, fmt.Errorf("open database: %w", err)
	}
	if _, err := db.ExecContext(ctx, schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("initialise schema: %w", err)
	}
	s := &Store{db: db, PasswordCost: bcrypt.DefaultCost, verified: map[[32]byte]string{}}
	m, err := s.migrate(ctx, path, existed, time.Now())
	if err != nil {
		db.Close()
		return nil, err
	}
	s.Migration = m
	return s, nil
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

const userColumns = `u.id, u.username, u.is_admin, u.disabled, u.note, u.created_at,
	(SELECT COUNT(*) FROM credentials c WHERE c.user_id = u.id),
	(SELECT COUNT(*) FROM credential_shares s WHERE s.user_id = u.id),
	(SELECT COUNT(*) FROM credentials c WHERE c.user_id = u.id
		AND EXISTS (SELECT 1 FROM credential_shares s WHERE s.credential_seq = c.seq)),
	(SELECT MAX(c.last_used_at) FROM credentials c WHERE c.user_id = u.id)`

type rowScanner interface{ Scan(dest ...any) error }

// scanUser scans userColumns. Columns selected before them are scanned into
// leading, in order.
func scanUser(r rowScanner, leading ...any) (User, error) {
	var (
		u        User
		created  int64
		lastUsed sql.NullInt64
	)
	dest := append(leading, &u.ID, &u.Username, &u.IsAdmin, &u.Disabled, &u.Note, &created,
		&u.CredentialCount, &u.SharedInCount, &u.SharedOutCount, &lastUsed)
	if err := r.Scan(dest...); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return User{}, ErrNotFound
		}
		return User{}, err
	}
	u.CreatedAt = fromMillis(created)
	u.LastUsedAt = fromNullMillis(lastUsed)
	return u, nil
}

// CreateUser creates an account as the system; see CreateUserAs.
func (s *Store) CreateUser(ctx context.Context, username, password string, isAdmin bool, now time.Time) (User, error) {
	return s.CreateUserAs(ctx, SystemActor, NewUser{Username: username, Password: password, IsAdmin: isAdmin}, now)
}

// GetUser returns the user with the given ID.
func (s *Store) GetUser(ctx context.Context, id int64) (User, error) {
	return resolveUser(ctx, s.db, UserKey{ID: id})
}

// UserFilter selects users for ListUsers. Zero fields do not filter.
type UserFilter struct {
	// Query matches a substring of the username or the note, ignoring case.
	Query    string
	Admin    *bool
	Disabled *bool
}

func (f UserFilter) matches(u User) bool {
	q := strings.ToLower(f.Query)
	return (f.Admin == nil || *f.Admin == u.IsAdmin) &&
		(f.Disabled == nil || *f.Disabled == u.Disabled) &&
		(q == "" || strings.Contains(strings.ToLower(u.Username), q) || strings.Contains(strings.ToLower(u.Note), q))
}

// ListUsers returns the users matching f, ordered by ID. The query is matched
// in Go because SQLite only folds the case of ASCII letters.
func (s *Store) ListUsers(ctx context.Context, f UserFilter) ([]User, error) {
	users, err := queryRows(ctx, s.db, func(r rowScanner) (User, error) { return scanUser(r) },
		`SELECT `+userColumns+` FROM users u ORDER BY u.id`)
	if err != nil {
		return nil, err
	}
	out := users[:0]
	for _, u := range users {
		if f.matches(u) {
			out = append(out, u)
		}
	}
	return out, nil
}

// Authenticate checks a username (case-insensitive) and password. It returns
// ErrBadPassword for an unknown user or a wrong password. Disabled users are
// returned like any other; callers reject them.
func (s *Store) Authenticate(ctx context.Context, username, password string) (User, error) {
	_, key, ok := NormalizeUsername(username)
	if !ok {
		return User{}, ErrBadPassword
	}
	var hash string
	user, err := scanUser(s.db.QueryRowContext(ctx,
		`SELECT u.password_hash, `+userColumns+` FROM users u WHERE u.username_key = ?`, key), &hash)
	if errors.Is(err, ErrNotFound) {
		return User{}, ErrBadPassword
	}
	if err != nil {
		return User{}, err
	}
	if !s.passwordMatches(key, password, hash) {
		return User{}, ErrBadPassword
	}
	return user, nil
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

// SetDisabled disables or re-enables the user's sign-in as the system; see
// UpdateUser.
func (s *Store) SetDisabled(ctx context.Context, id int64, disabled bool) error {
	_, err := s.UpdateUser(ctx, SystemActor, id, UserUpdate{Disabled: &disabled}, time.Now())
	return err
}

// EnsureAdmin makes sure the named user exists and is an administrator, acting
// as the system. A new user gets the given password; an existing user keeps
// its password.
func (s *Store) EnsureAdmin(ctx context.Context, username, password string, now time.Time) (created bool, err error) {
	_, key, ok := NormalizeUsername(username)
	if !ok {
		return false, fmt.Errorf("invalid admin username %q", username)
	}
	s.reservedKey = key
	user, err := resolveUser(ctx, s.db, UserKey{Username: username})
	switch {
	case err == nil:
		_, err = s.UpdateUser(ctx, SystemActor, user.ID, UserUpdate{IsAdmin: new(true)}, now)
		return false, err
	case errors.Is(err, ErrNotFound):
		_, err = s.CreateUserAs(ctx, SystemActor, NewUser{Username: username, Password: password, IsAdmin: true}, now)
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
	var expires int64
	user, err := scanUser(s.db.QueryRowContext(ctx,
		`SELECT s.expires_at, `+userColumns+` FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`, token),
		&expires)
	if err != nil {
		return User{}, err
	}
	if toMillis(now) >= expires {
		_ = s.DeleteSession(ctx, token)
		return User{}, ErrNotFound
	}
	return user, nil
}

// DeleteSession removes a session; a missing session is not an error.
func (s *Store) DeleteSession(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token = ?`, token)
	return err
}
