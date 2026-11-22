package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/riba2534/passkey-box/server/internal/store"
)

// Limits on batch requests (docs/API.md).
const (
	maxBatchIDs     = 1000
	maxBatchUsers   = 100
	maxSharePairs   = 10000
	maxBatchCreate  = 200
	maxBatchUpdates = 1000
)

// userRef is a user reference in a JSON request body: a JSON number is a user
// ID, a JSON string a username. Raw keeps the value as sent, for error items.
type userRef struct {
	Key store.UserKey
	Raw any
}

func (u *userRef) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) > 0 && b[0] == '"' {
		var name string
		if err := json.Unmarshal(b, &name); err != nil {
			return err
		}
		*u = userRef{Key: store.UserKey{Username: name}, Raw: name}
		return nil
	}
	var id int64
	if err := json.Unmarshal(b, &id); err != nil || id <= 0 {
		return fmt.Errorf("a user is a positive ID or a username")
	}
	*u = userRef{Key: store.UserKey{ID: id}, Raw: id}
	return nil
}

// userKeys returns the store keys of refs.
func userKeys(refs []userRef) []store.UserKey {
	keys := make([]store.UserKey, len(refs))
	for i, r := range refs {
		keys[i] = r.Key
	}
	return keys
}

// checkBatchSize answers 400 and returns false when a batch field is empty or
// longer than limit.
func checkBatchSize(w http.ResponseWriter, field string, n, limit int) bool {
	switch {
	case n == 0:
		badRequest(w, field+" must not be empty")
		return false
	case n > limit:
		badRequest(w, fmt.Sprintf("%s holds at most %d items", field, limit))
		return false
	}
	return true
}

// writeStoreError answers a failed store call: a *store.BatchError becomes
// 400 with the failed items; ErrNotFound uses notFound; ErrForbidden 403,
// ErrConflict 409, *store.InvalidError 400; anything else 500.
func (s *Server) writeStoreError(w http.ResponseWriter, err error, notFound func(http.ResponseWriter)) {
	var batch *store.BatchError
	var invalid *store.InvalidError
	switch {
	case errors.As(err, &batch):
		writeJSON(w, http.StatusBadRequest, errorBody{Error: errorDetail{
			Code:    "invalid_request",
			Message: fmt.Sprintf("%d items failed", len(batch.Items)),
			Items:   batch.Items,
		}})
	case errors.Is(err, store.ErrNotFound):
		notFound(w)
	case errors.Is(err, store.ErrForbidden):
		writeError(w, http.StatusForbidden, "forbidden", "only the owner can do this")
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, "conflict", "already exists")
	case errors.As(err, &invalid):
		badRequest(w, invalid.Reason)
	default:
		s.internalError(w, err)
	}
}
