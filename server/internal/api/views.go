package api

import (
	"time"

	"github.com/riba2534/passkey-box/server/internal/store"
)

type userView struct {
	ID              int64   `json:"id"`
	Username        string  `json:"username"`
	IsAdmin         bool    `json:"is_admin"`
	Disabled        bool    `json:"disabled"`
	CreatedAt       string  `json:"created_at"`
	CredentialCount int     `json:"credential_count"`
	SharedInCount   int     `json:"shared_in_count"`
	SharedOutCount  int     `json:"shared_out_count"`
	LastUsedAt      *string `json:"last_used_at"`
}

// adminUserView is the user as administrators see it, with their note.
type adminUserView struct {
	userView
	Note string `json:"note"`
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
		Disabled:        u.Disabled,
		CreatedAt:       formatTime(u.CreatedAt),
		CredentialCount: u.CredentialCount,
		SharedInCount:   u.SharedInCount,
		SharedOutCount:  u.SharedOutCount,
		LastUsedAt:      formatTimePtr(u.LastUsedAt),
	}
}

func newAdminUserView(u store.User) adminUserView {
	return adminUserView{userView: newUserView(u), Note: u.Note}
}

func newAdminUserViews(users []store.User) []adminUserView {
	out := make([]adminUserView, 0, len(users))
	for _, u := range users {
		out = append(out, newAdminUserView(u))
	}
	return out
}
