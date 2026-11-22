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
// ID, a JSON string a username.
type userRef struct {
	Key store.UserKey
}

func (u *userRef) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) > 0 && b[0] == '"' {
		var name string
		if err := json.Unmarshal(b, &name); err != nil {
			return err
		}
		*u = userRef{Key: store.UserKey{Username: name}}
		return nil
	}
	var id int64
	if err := json.Unmarshal(b, &id); err != nil || id <= 0 {
		return fmt.Errorf("a user is a positive ID or a username")
	}
	*u = userRef{Key: store.UserKey{ID: id}}
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

// codeStatus is the HTTP status of each store error code but not_found.
var codeStatus = map[string]int{
	store.CodeForbidden: http.StatusForbidden,
	store.CodeConflict:  http.StatusConflict,
	store.CodeInvalid:   http.StatusBadRequest,
}

// writeStoreError answers a failed store call: a *store.BatchError becomes
// 400 with the failed items, ErrNotFound uses notFound, the other errors
// store.Classify knows get their code and message, and anything else is 500.
func (s *Server) writeStoreError(w http.ResponseWriter, err error, notFound func(http.ResponseWriter)) {
	var batch *store.BatchError
	switch {
	case errors.As(err, &batch):
		writeJSON(w, http.StatusBadRequest, errorBody{Error: errorDetail{
			Code:    store.CodeInvalid,
			Message: fmt.Sprintf("%d items failed", len(batch.Items)),
			Items:   batch.Items,
		}})
		return
	case errors.Is(err, store.ErrNotFound):
		notFound(w)
		return
	}
	code, message, ok := store.Classify(err, "")
	if !ok {
		s.internalError(w, err)
		return
	}
	writeError(w, codeStatus[code], code, message)
}

// writeNoContent answers 204 on success and like writeStoreError otherwise.
func (s *Server) writeNoContent(w http.ResponseWriter, err error, notFound func(http.ResponseWriter)) {
	if err != nil {
		s.writeStoreError(w, err, notFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
