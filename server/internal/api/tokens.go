package api

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/riba2534/passkey-box/server/internal/store"
)

type tokenView struct {
	ID         int64   `json:"id"`
	Name       string  `json:"name"`
	Prefix     string  `json:"prefix"`
	ReadOnly   bool    `json:"read_only"`
	CreatedAt  string  `json:"created_at"`
	ExpiresAt  *string `json:"expires_at"`
	LastUsedAt *string `json:"last_used_at"`
}

func newTokenView(t store.APIToken) tokenView {
	return tokenView{
		ID:         t.ID,
		Name:       t.Name,
		Prefix:     t.Prefix,
		ReadOnly:   t.ReadOnly,
		CreatedAt:  formatTime(t.CreatedAt),
		ExpiresAt:  formatTimePtr(t.ExpiresAt),
		LastUsedAt: formatTimePtr(t.LastUsedAt),
	}
}

// Limits on new API tokens (docs/API.md).
const (
	maxTokenNameLen = 64
	maxTokenDays    = 3650
)

func tokenNotFound(w http.ResponseWriter) {
	writeError(w, http.StatusNotFound, "not_found", "token not found")
}

func (s *Server) handleListTokens(w http.ResponseWriter, r *http.Request, c *caller) {
	tokens, err := s.opts.Store.ListTokens(r.Context(), c.User.ID)
	if err != nil {
		s.internalError(w, err)
		return
	}
	views := make([]tokenView, 0, len(tokens))
	for _, t := range tokens {
		views = append(views, newTokenView(t))
	}
	writeJSON(w, http.StatusOK, map[string]any{"tokens": views})
}

func (s *Server) handleCreateToken(w http.ResponseWriter, r *http.Request, c *caller) {
	var req struct {
		Name          string `json:"name"`
		ReadOnly      bool   `json:"read_only"`
		ExpiresInDays *int   `json:"expires_in_days"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	name := strings.TrimSpace(req.Name)
	if n := utf8.RuneCountInString(name); n < 1 || n > maxTokenNameLen {
		badRequest(w, fmt.Sprintf("name must be 1-%d characters", maxTokenNameLen))
		return
	}
	now := s.opts.Now()
	var expires *time.Time
	if d := req.ExpiresInDays; d != nil {
		if *d < 1 || *d > maxTokenDays {
			badRequest(w, fmt.Sprintf("expires_in_days must be between 1 and %d", maxTokenDays))
			return
		}
		expires = new(now.Add(time.Duration(*d) * 24 * time.Hour))
	}
	token, secret, err := s.opts.Store.CreateToken(r.Context(), c.actor(), c.User.ID, name, req.ReadOnly, expires, now)
	if err != nil {
		s.writeStoreError(w, err, userNotFound)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"token": newTokenView(token), "secret": secret})
}

func (s *Server) handleDeleteToken(w http.ResponseWriter, r *http.Request, c *caller) {
	id, err := strconv.ParseInt(r.PathValue("token_id"), 10, 64)
	if err != nil {
		tokenNotFound(w)
		return
	}
	s.writeNoContent(w, s.opts.Store.DeleteToken(r.Context(), c.actor(), c.User.ID, id, s.opts.Now()), tokenNotFound)
}
