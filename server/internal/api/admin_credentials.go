package api

import (
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"

	"github.com/riba2534/passkey-box/server/internal/store"
)

const (
	defaultCredentialPage = 100
	maxCredentialPage     = 500
)

func (s *Server) handleAdminListUserCredentials(w http.ResponseWriter, r *http.Request, _ *caller) {
	target, ok := s.targetUser(w, r)
	if !ok {
		return
	}
	s.writeCredentials(w, r, target.ID, false, true)
}

func (s *Server) handleAdminDeleteUserCredential(w http.ResponseWriter, r *http.Request, c *caller) {
	target, ok := s.targetUser(w, r)
	if !ok {
		return
	}
	err := s.opts.Store.DeleteCredential(r.Context(), c.actor(), target.ID, r.PathValue("id"), s.opts.Now())
	s.writeNoContent(w, err, credentialNotFound)
}

// adminCredentialFilter parses the query of GET /admin/credentials. It
// answers 400 and returns false for malformed or out-of-range parameters.
func adminCredentialFilter(w http.ResponseWriter, r *http.Request) (store.CredentialFilter, bool) {
	q := r.URL.Query()
	f := store.CredentialFilter{
		Owner:      strings.TrimSpace(q.Get("owner")),
		SharedWith: strings.TrimSpace(q.Get("shared_with")),
		RPID:       strings.TrimSpace(q.Get("rp_id")),
		Query:      strings.TrimSpace(q.Get("q")),
		Limit:      defaultCredentialPage,
	}
	// number parses an optional integer parameter into dst, which keeps its
	// default when the parameter is absent.
	number := func(name string, min, max int64, dst *int64) bool {
		v := q.Get(name)
		if v == "" {
			return true
		}
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < min || n > max {
			msg := fmt.Sprintf("%s must be an integer from %d to %d", name, min, max)
			if max == math.MaxInt64 {
				msg = fmt.Sprintf("%s must be an integer of at least %d", name, min)
			}
			badRequest(w, msg)
			return false
		}
		*dst = n
		return true
	}
	limit, offset := int64(f.Limit), int64(0)
	if !number("owner_id", 1, math.MaxInt64, &f.OwnerID) || !number("shared_with_id", 1, math.MaxInt64, &f.SharedWithID) ||
		!number("limit", 1, maxCredentialPage, &limit) || !number("offset", 0, math.MaxInt64, &offset) {
		return f, false
	}
	f.Limit, f.Offset = int(limit), int(offset)
	switch q.Get("shared") {
	case "":
	case "true", "false":
		shared := q.Get("shared") == "true"
		f.Shared = &shared
	default:
		badRequest(w, "shared must be true or false")
		return f, false
	}
	return f, true
}

func (s *Server) handleAdminListCredentials(w http.ResponseWriter, r *http.Request, _ *caller) {
	f, ok := adminCredentialFilter(w, r)
	if !ok {
		return
	}
	creds, total, err := s.opts.Store.ListAllCredentials(r.Context(), f)
	if err != nil {
		s.internalError(w, err)
		return
	}
	views := make([]credentialView, 0, len(creds))
	for _, cred := range creds {
		views = append(views, newAdminCredentialView(cred))
	}
	writeJSON(w, http.StatusOK, map[string]any{"credentials": views, "total": total, "limit": f.Limit, "offset": f.Offset})
}

func (s *Server) handleAdminGetCredential(w http.ResponseWriter, r *http.Request, _ *caller) {
	cred, err := s.opts.Store.GetAnyCredential(r.Context(), r.PathValue("id"))
	if err != nil {
		s.writeStoreError(w, err, credentialNotFound)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"credential": newAdminCredentialView(cred)})
}

func (s *Server) handleAdminUpdateCredential(w http.ResponseWriter, r *http.Request, c *caller) {
	label, ok := readLabel(w, r)
	if !ok {
		return
	}
	cred, err := s.opts.Store.AdminSetCredentialLabel(r.Context(), c.actor(), r.PathValue("id"), label, s.opts.Now())
	if err != nil {
		s.writeStoreError(w, err, credentialNotFound)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"credential": newAdminCredentialView(cred)})
}

func (s *Server) handleAdminDeleteCredential(w http.ResponseWriter, r *http.Request, c *caller) {
	err := s.opts.Store.AdminDeleteCredential(r.Context(), c.actor(), r.PathValue("id"), s.opts.Now())
	s.writeNoContent(w, err, credentialNotFound)
}

func (s *Server) handleAdminShare(w http.ResponseWriter, r *http.Request, c *caller) {
	s.shareCredentials(w, r, c, true)
}

func (s *Server) handleAdminUnshare(w http.ResponseWriter, r *http.Request, c *caller) {
	s.unshareCredentials(w, r, c, true)
}

func (s *Server) handleAdminTransfer(w http.ResponseWriter, r *http.Request, c *caller) {
	s.transferCredentials(w, r, c, true)
}

func (s *Server) handleAdminBatchDeleteCredentials(w http.ResponseWriter, r *http.Request, c *caller) {
	s.deleteCredentials(w, r, c, true)
}
