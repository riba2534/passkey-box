package api

import (
	"fmt"
	"net/http"

	"github.com/riba2534/passkey-box/server/internal/store"
)

// credentialBatchRequest holds the fields of every credential batch request.
type credentialBatchRequest struct {
	IDs    []string `json:"ids"`
	DryRun bool     `json:"dry_run"`
}

// batch returns the store batch for the request. With admin it may touch any
// user's credentials; otherwise only the caller's.
func (req credentialBatchRequest) batch(s *Server, c *caller, admin bool) store.CredentialBatch {
	return store.CredentialBatch{Actor: c.actor(), Admin: admin, IDs: req.IDs, DryRun: req.DryRun, Now: s.opts.Now()}
}

// checkShareUsers checks the size of a users field and of ids × users. It
// answers 400 and returns false when either is out of range.
func checkShareUsers(w http.ResponseWriter, ids, users int) bool {
	if !checkBatchSize(w, "users", users, maxBatchUsers) {
		return false
	}
	if ids*users > maxSharePairs {
		badRequest(w, fmt.Sprintf("ids × users holds at most %d pairs", maxSharePairs))
		return false
	}
	return true
}

// scoped binds whether a credential batch handler may reach every user's
// credentials (the admin routes) or only the caller's.
func scoped(h func(http.ResponseWriter, *http.Request, *caller, bool), admin bool) authedHandler {
	return func(w http.ResponseWriter, r *http.Request, c *caller) { h(w, r, c, admin) }
}

// writeCredentialBatch answers the results of a credential batch, or its error.
func writeCredentialBatch[R, V any](s *Server, w http.ResponseWriter, dryRun bool, results []R, err error, view func(R) V) {
	if err != nil {
		s.writeStoreError(w, err, credentialNotFound)
		return
	}
	out := make([]V, 0, len(results))
	for _, r := range results {
		out = append(out, view(r))
	}
	writeJSON(w, http.StatusOK, map[string]any{"dry_run": dryRun, "results": out})
}

func (s *Server) shareCredentials(w http.ResponseWriter, r *http.Request, c *caller, admin bool) {
	var req struct {
		credentialBatchRequest
		Users []userRef `json:"users"`
	}
	if !readJSON(w, r, &req) || !checkBatchSize(w, "ids", len(req.IDs), maxBatchIDs) ||
		!checkShareUsers(w, len(req.IDs), len(req.Users)) {
		return
	}
	results, err := s.opts.Store.ShareCredentials(r.Context(), req.batch(s, c, admin), userKeys(req.Users))
	writeCredentialBatch(s, w, req.DryRun, results, err, newShareResultView)
}

func (s *Server) unshareCredentials(w http.ResponseWriter, r *http.Request, c *caller, admin bool) {
	var req struct {
		credentialBatchRequest
		Users []userRef `json:"users"`
		All   bool      `json:"all"`
	}
	if !readJSON(w, r, &req) || !checkBatchSize(w, "ids", len(req.IDs), maxBatchIDs) {
		return
	}
	if (req.Users != nil) == req.All {
		badRequest(w, "give exactly one of users and all: true")
		return
	}
	if !req.All && !checkShareUsers(w, len(req.IDs), len(req.Users)) {
		return
	}
	results, err := s.opts.Store.UnshareCredentials(r.Context(), req.batch(s, c, admin), userKeys(req.Users), req.All)
	writeCredentialBatch(s, w, req.DryRun, results, err, newShareResultView)
}

func (s *Server) transferCredentials(w http.ResponseWriter, r *http.Request, c *caller, admin bool) {
	var req struct {
		credentialBatchRequest
		To         *userRef `json:"to"`
		KeepAccess bool     `json:"keep_access"`
	}
	if !readJSON(w, r, &req) || !checkBatchSize(w, "ids", len(req.IDs), maxBatchIDs) {
		return
	}
	if req.To == nil {
		badRequest(w, "to is required")
		return
	}
	results, err := s.opts.Store.TransferCredentials(r.Context(), req.batch(s, c, admin), req.To.Key, req.KeepAccess)
	writeCredentialBatch(s, w, req.DryRun, results, err, newTransferResultView)
}

func (s *Server) handleLeave(w http.ResponseWriter, r *http.Request, c *caller) {
	var req credentialBatchRequest
	if !readJSON(w, r, &req) || !checkBatchSize(w, "ids", len(req.IDs), maxBatchIDs) {
		return
	}
	results, err := s.opts.Store.LeaveCredentials(r.Context(), req.batch(s, c, false))
	writeCredentialBatch(s, w, req.DryRun, results, err, newCredentialResultView)
}

func (s *Server) deleteCredentials(w http.ResponseWriter, r *http.Request, c *caller, admin bool) {
	var req credentialBatchRequest
	if !readJSON(w, r, &req) || !checkBatchSize(w, "ids", len(req.IDs), maxBatchIDs) {
		return
	}
	results, err := s.opts.Store.DeleteCredentials(r.Context(), req.batch(s, c, admin))
	writeCredentialBatch(s, w, req.DryRun, results, err, newCredentialResultView)
}
