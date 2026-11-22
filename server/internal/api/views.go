package api

import (
	"time"

	"github.com/riba2534/passkey-box/server/internal/store"
)

type userView struct {
	ID              int64   `json:"id"`
	Username        string  `json:"username"`
	IsAdmin         bool    `json:"is_admin"`
	CreatedAt       string  `json:"created_at"`
	CredentialCount int     `json:"credential_count"`
	LastUsedAt      *string `json:"last_used_at"`
}

func formatTime(t time.Time) string { return t.UTC().Format(time.RFC3339) }

func formatTimePtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := formatTime(*t)
	return &s
}

func newUserView(u store.User) userView {
	return userView{
		ID:              u.ID,
		Username:        u.Username,
		IsAdmin:         u.IsAdmin,
		CreatedAt:       formatTime(u.CreatedAt),
		CredentialCount: u.CredentialCount,
		LastUsedAt:      formatTimePtr(u.LastUsedAt),
	}
}

func newUserViews(users []store.User) []userView {
	out := make([]userView, 0, len(users))
	for _, u := range users {
		out = append(out, newUserView(u))
	}
	return out
}
