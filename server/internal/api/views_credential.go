package api

import "github.com/riba2534/passkey-box/server/internal/store"

// credentialView is a Credential. PrivateKey is only set for HTTP Basic
// callers of the user credential endpoints (see caller.privateKeys) and is
// omitted otherwise; SharedWith is omitted where share recipients look.
// Fields is always a list (the store never loads nil), shown in full to
// everyone who sees the credential.
type credentialView struct {
	ID              string        `json:"id"`
	RPID            string        `json:"rp_id"`
	RPName          string        `json:"rp_name"`
	UserHandle      string        `json:"user_handle"`
	UserName        string        `json:"user_name"`
	UserDisplayName string        `json:"user_display_name"`
	Alg             int           `json:"alg"`
	PrivateKey      *string       `json:"private_key,omitempty"`
	PublicKey       string        `json:"public_key"`
	SignCount       int64         `json:"sign_count"`
	Label           string        `json:"label"`
	Fields          []store.Field `json:"fields"`
	Origin          string        `json:"origin"`
	CreatedAt       string        `json:"created_at"`
	LastUsedAt      *string       `json:"last_used_at"`
	UseCount        int64         `json:"use_count"`
	Owner           userBriefView `json:"owner"`
	SharedWith      []shareView   `json:"shared_with,omitzero"`
}

type shareView struct {
	User       userBriefView  `json:"user"`
	SharedAt   string         `json:"shared_at"`
	SharedBy   *userBriefView `json:"shared_by"`
	LastUsedAt *string        `json:"last_used_at"`
}

// accessCredentialView is a credential in the list of one user, which says how
// that user reaches it: /credentials* and /admin/users/{user_id}/credentials.
type accessCredentialView struct {
	credentialView
	Access   string  `json:"access"`
	SharedAt *string `json:"shared_at"`
}

// newCredentialView builds the view of c, with the private key and the list of
// shares when asked for.
func newCredentialView(c store.Credential, privateKey, sharedWith bool) credentialView {
	v := credentialView{
		ID:              c.ID,
		RPID:            c.RPID,
		RPName:          c.RPName,
		UserHandle:      c.UserHandle,
		UserName:        c.UserName,
		UserDisplayName: c.UserDisplayName,
		Alg:             c.Alg,
		PublicKey:       c.PublicKey,
		SignCount:       c.SignCount,
		Label:           c.Label,
		Fields:          c.Fields,
		Origin:          c.Origin,
		CreatedAt:       formatTime(c.CreatedAt),
		LastUsedAt:      formatTimePtr(c.LastUsedAt),
		UseCount:        c.UseCount,
		Owner:           newUserBriefView(c.Owner),
	}
	if privateKey {
		v.PrivateKey = &c.PrivateKey
	}
	if sharedWith {
		v.SharedWith = make([]shareView, 0, len(c.Shares))
		for _, sh := range c.Shares {
			v.SharedWith = append(v.SharedWith, shareView{
				User:       newUserBriefView(sh.User),
				SharedAt:   formatTime(sh.SharedAt),
				SharedBy:   newUserBriefPtr(sh.SharedBy),
				LastUsedAt: formatTimePtr(sh.LastUsedAt),
			})
		}
	}
	return v
}

// newAdminCredentialView is c as /admin/credentials* show it: with its
// shares, without the private key.
func newAdminCredentialView(c store.Credential) credentialView {
	return newCredentialView(c, false, true)
}

// newAccessCredentialView is c in a user's list. The shares are listed for
// the owner and for administrators (admin), never for share recipients.
func newAccessCredentialView(c store.Credential, privateKey, admin bool) accessCredentialView {
	return accessCredentialView{
		credentialView: newCredentialView(c, privateKey, admin || c.Access == store.AccessOwner),
		Access:         c.Access,
		SharedAt:       formatTimePtr(c.SharedAt),
	}
}

func newAccessCredentialViews(creds []store.Credential, privateKey, admin bool) []accessCredentialView {
	out := make([]accessCredentialView, 0, len(creds))
	for _, c := range creds {
		out = append(out, newAccessCredentialView(c, privateKey, admin))
	}
	return out
}

type credentialBriefView struct {
	ID       string        `json:"id"`
	RPID     string        `json:"rp_id"`
	UserName string        `json:"user_name"`
	Owner    userBriefView `json:"owner"`
}

func newCredentialBriefView(c store.CredentialBrief) credentialBriefView {
	return credentialBriefView{ID: c.ID, RPID: c.RPID, UserName: c.UserName, Owner: newUserBriefView(c.Owner)}
}

type shareResultView struct {
	Credential credentialBriefView `json:"credential"`
	User       userBriefView       `json:"user"`
	Status     string              `json:"status"`
	Warnings   []string            `json:"warnings"`
}

func newShareResultView(r store.ShareResult) shareResultView {
	return shareResultView{Credential: newCredentialBriefView(r.Credential), User: newUserBriefView(r.User),
		Status: r.Status, Warnings: r.Warnings}
}

type transferResultView struct {
	Credential credentialBriefView `json:"credential"`
	From       userBriefView       `json:"from"`
	To         userBriefView       `json:"to"`
	Status     string              `json:"status"`
	KeepAccess bool                `json:"keep_access"`
	Warnings   []string            `json:"warnings"`
}

func newTransferResultView(r store.TransferResult) transferResultView {
	return transferResultView{Credential: newCredentialBriefView(r.Credential), From: newUserBriefView(r.From),
		To: newUserBriefView(r.To), Status: r.Status, KeepAccess: r.KeepAccess, Warnings: r.Warnings}
}

type credentialResultView struct {
	Credential credentialBriefView `json:"credential"`
	Status     string              `json:"status"`
	Warnings   []string            `json:"warnings"`
}

func newCredentialResultView(r store.CredentialResult) credentialResultView {
	return credentialResultView{Credential: newCredentialBriefView(r.Credential), Status: r.Status, Warnings: r.Warnings}
}
