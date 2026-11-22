package api

import (
	"net/http"

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

func (s *Server) handleListTokens(w http.ResponseWriter, r *http.Request, c *caller) {
	notImplemented(w)
}

func (s *Server) handleCreateToken(w http.ResponseWriter, r *http.Request, c *caller) {
	notImplemented(w)
}

func (s *Server) handleDeleteToken(w http.ResponseWriter, r *http.Request, c *caller) {
	notImplemented(w)
}
