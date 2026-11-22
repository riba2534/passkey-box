package api

import "github.com/riba2534/passkey-box/server/internal/store"

// userBriefView is a UserBrief: a credential owner, a share recipient or an
// audit party.
type userBriefView struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
}

func newUserBriefView(u store.UserBrief) userBriefView {
	return userBriefView{ID: u.ID, Username: u.Username}
}

// newUserBriefPtr returns nil for a nil user, for nullable fields such as
// shared_by.
func newUserBriefPtr(u *store.UserBrief) *userBriefView {
	if u == nil {
		return nil
	}
	v := newUserBriefView(*u)
	return &v
}
