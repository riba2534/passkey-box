package api

import "github.com/riba2534/passkey-box/server/internal/store"

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
