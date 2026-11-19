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

type credentialView struct {
	ID              string  `json:"id"`
	RPID            string  `json:"rp_id"`
	RPName          string  `json:"rp_name"`
	UserHandle      string  `json:"user_handle"`
	UserName        string  `json:"user_name"`
	UserDisplayName string  `json:"user_display_name"`
	Alg             int     `json:"alg"`
	PrivateKey      string  `json:"private_key"`
	PublicKey       string  `json:"public_key"`
	SignCount       int64   `json:"sign_count"`
	Label           string  `json:"label"`
	Origin          string  `json:"origin"`
	CreatedAt       string  `json:"created_at"`
	LastUsedAt      *string `json:"last_used_at"`
	UseCount        int64   `json:"use_count"`
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

func newCredentialView(c store.Credential) credentialView {
	return credentialView{
		ID:              c.ID,
		RPID:            c.RPID,
		RPName:          c.RPName,
		UserHandle:      c.UserHandle,
		UserName:        c.UserName,
		UserDisplayName: c.UserDisplayName,
		Alg:             c.Alg,
		PrivateKey:      c.PrivateKey,
		PublicKey:       c.PublicKey,
		SignCount:       c.SignCount,
		Label:           c.Label,
		Origin:          c.Origin,
		CreatedAt:       formatTime(c.CreatedAt),
		LastUsedAt:      formatTimePtr(c.LastUsedAt),
		UseCount:        c.UseCount,
	}
}

func newCredentialViews(creds []store.Credential) []credentialView {
	out := make([]credentialView, 0, len(creds))
	for _, c := range creds {
		out = append(out, newCredentialView(c))
	}
	return out
}
