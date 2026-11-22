package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// queryer is a *sql.DB or *sql.Tx.
type queryer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// inTx runs fn in a transaction and commits it, unless fn fails or dryRun is
// set: a dry run computes the same results and then rolls everything back,
// including the audit rows fn wrote.
func (s *Store) inTx(ctx context.Context, dryRun bool, fn func(tx *sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	if dryRun {
		return nil
	}
	return tx.Commit()
}

// queryRows runs query on q and scans every row with scan.
func queryRows[T any](ctx context.Context, q queryer, scan func(rowScanner) (T, error), query string, args ...any) ([]T, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []T{}
	for rows.Next() {
		v, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// resolveUser loads the user a UserKey refers to, or returns ErrNotFound.
func resolveUser(ctx context.Context, q queryer, key UserKey) (User, error) {
	if key.ID != 0 {
		return scanUser(q.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users u WHERE u.id = ?`, key.ID))
	}
	_, nameKey, ok := NormalizeUsername(key.Username)
	if !ok {
		return User{}, ErrNotFound
	}
	return scanUser(q.QueryRowContext(ctx, `SELECT `+userColumns+` FROM users u WHERE u.username_key = ?`, nameKey))
}

// userBrief returns the ID and name of a user, or ErrNotFound.
func userBrief(ctx context.Context, q queryer, id int64) (UserBrief, error) {
	return scanUserBrief(q.QueryRowContext(ctx, `SELECT id, username FROM users WHERE id = ?`, id))
}

// scanUserBrief scans a user's ID and name.
func scanUserBrief(r rowScanner) (UserBrief, error) {
	var u UserBrief
	err := r.Scan(&u.ID, &u.Username)
	if errors.Is(err, sql.ErrNoRows) {
		return UserBrief{}, ErrNotFound
	}
	return u, err
}

// execCount runs a statement on q and returns the number of rows it changed.
func execCount(ctx context.Context, q queryer, query string, args ...any) (int64, error) {
	res, err := q.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// InvalidError reports a request the store refuses for the given reason.
type InvalidError struct{ Reason string }

func (e *InvalidError) Error() string { return e.Reason }

// Invalid returns an *InvalidError with the given reason.
func Invalid(format string, args ...any) error {
	return &InvalidError{Reason: fmt.Sprintf(format, args...)}
}

// Item error codes, the same codes the HTTP API uses for single requests.
const (
	CodeNotFound  = "not_found"
	CodeForbidden = "forbidden"
	CodeConflict  = "conflict"
	CodeInvalid   = "invalid_request"
)

// ItemError is one failed entry of a batch request. Field names the request
// field and Index the position in it (0 for single-valued fields); Value is
// the entry as the client sent it.
type ItemError struct {
	Field   string `json:"field"`
	Index   int    `json:"index"`
	Value   any    `json:"value"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// BatchError collects the failed entries of an all-or-nothing batch.
type BatchError struct {
	Items []ItemError
}

func (e *BatchError) Error() string {
	parts := make([]string, 0, len(e.Items))
	for _, it := range e.Items {
		parts = append(parts, fmt.Sprintf("%s[%d]: %s", it.Field, it.Index, it.Message))
	}
	return "batch failed: " + strings.Join(parts, "; ")
}

// Add records a failed entry.
func (e *BatchError) Add(field string, index int, value any, code, message string) {
	e.Items = append(e.Items, ItemError{Field: field, Index: index, Value: value, Code: code, Message: message})
}

// AddErr records a failed entry from a store error: ErrNotFound, ErrForbidden,
// ErrConflict and *InvalidError map to their codes with notFound used as the
// not-found message. Any other error is returned unchanged so the caller can
// abort; nil is returned when err was recorded.
func (e *BatchError) AddErr(field string, index int, value any, err error, notFound string) error {
	var inv *InvalidError
	switch {
	case errors.Is(err, ErrNotFound):
		e.Add(field, index, value, CodeNotFound, notFound)
	case errors.Is(err, ErrForbidden):
		e.Add(field, index, value, CodeForbidden, "only the owner can do this")
	case errors.Is(err, ErrConflict):
		e.Add(field, index, value, CodeConflict, "already exists")
	case errors.As(err, &inv):
		e.Add(field, index, value, CodeInvalid, inv.Reason)
	default:
		return err
	}
	return nil
}

// Err returns e when it holds failed entries, or nil.
func (e *BatchError) Err() error {
	if len(e.Items) == 0 {
		return nil
	}
	return e
}
