package api

import (
	"crypto/rand"
	"fmt"
	"net/http"

	"github.com/riba2534/passkey-box/server/internal/store"
)

const (
	passwordAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	generatedLen     = 16
)

// generatePassword returns a random password of letters and digits.
func generatePassword() string {
	// Bytes from 248 = 4 × 62 up are skipped so that every character is
	// equally likely.
	const limit = 4 * len(passwordAlphabet)
	out := make([]byte, 0, generatedLen)
	buf := make([]byte, 2*generatedLen)
	for len(out) < generatedLen {
		rand.Read(buf) // never fails
		for _, b := range buf {
			if int(b) < limit && len(out) < generatedLen {
				out = append(out, passwordAlphabet[int(b)%len(passwordAlphabet)])
			}
		}
	}
	return string(out)
}

// shownPassword is the password a batch result reveals: the one the server
// generated, if any, and only when the batch was really applied.
func shownPassword(generated string, dryRun bool) string {
	if dryRun {
		return ""
	}
	return generated
}

func (s *Server) handleAdminBatchCreateUsers(w http.ResponseWriter, r *http.Request, c *caller) {
	var req struct {
		Users []struct {
			Username *string `json:"username"`
			Password *string `json:"password"`
			IsAdmin  bool    `json:"is_admin"`
			Note     string  `json:"note"`
		} `json:"users"`
		DryRun bool `json:"dry_run"`
	}
	if !readJSON(w, r, &req) || !checkBatchSize(w, "users", len(req.Users), maxBatchCreate) {
		return
	}
	users := make([]store.NewUser, len(req.Users))
	generated := make([]string, len(req.Users))
	for i, u := range req.Users {
		if u.Username == nil {
			badRequest(w, fmt.Sprintf("users[%d].username is required", i))
			return
		}
		users[i] = store.NewUser{Username: *u.Username, IsAdmin: u.IsAdmin, Note: u.Note}
		if u.Password != nil {
			users[i].Password = *u.Password
		} else {
			generated[i] = generatePassword()
			users[i].Password = generated[i]
		}
	}
	created, err := s.opts.Store.CreateUsers(r.Context(), c.actor(), users, req.DryRun, s.opts.Now())
	if err != nil {
		s.writeStoreError(w, err, userNotFound)
		return
	}
	type result struct {
		User     adminUserView `json:"user"`
		Password string        `json:"password,omitempty"`
	}
	results := make([]result, len(created))
	for i, u := range created {
		results[i] = result{User: newAdminUserView(u), Password: shownPassword(generated[i], req.DryRun)}
	}
	writeJSON(w, http.StatusOK, map[string]any{"dry_run": req.DryRun, "results": results})
}

func (s *Server) handleAdminBatchUpdateUsers(w http.ResponseWriter, r *http.Request, c *caller) {
	var req struct {
		Items []struct {
			User *userRef `json:"user"`
			userUpdateRequest
			GeneratePassword bool `json:"generate_password"`
		} `json:"items"`
		DryRun bool `json:"dry_run"`
	}
	if !readJSON(w, r, &req) || !checkBatchSize(w, "items", len(req.Items), maxBatchUpdates) {
		return
	}
	edits := make([]store.UserEdit, len(req.Items))
	generated := make([]string, len(req.Items))
	for i, it := range req.Items {
		switch {
		case it.User == nil:
			badRequest(w, fmt.Sprintf("items[%d].user is required", i))
			return
		case it.GeneratePassword && it.Password != nil:
			badRequest(w, fmt.Sprintf("items[%d]: password and generate_password are mutually exclusive", i))
			return
		}
		edits[i] = store.UserEdit{User: it.User.Key, UserUpdate: store.UserUpdate(it.userUpdateRequest)}
		if it.GeneratePassword {
			generated[i] = generatePassword()
			edits[i].Password = &generated[i]
		}
	}
	updated, err := s.opts.Store.UpdateUsers(r.Context(), c.actor(), edits, req.DryRun, s.opts.Now())
	if err != nil {
		s.writeStoreError(w, err, userNotFound)
		return
	}
	type result struct {
		User     adminUserView `json:"user"`
		Changes  []string      `json:"changes"`
		Password string        `json:"password,omitempty"`
	}
	results := make([]result, len(updated))
	for i, u := range updated {
		results[i] = result{User: newAdminUserView(u.User), Changes: u.Changes, Password: shownPassword(generated[i], req.DryRun)}
	}
	writeJSON(w, http.StatusOK, map[string]any{"dry_run": req.DryRun, "results": results})
}

func (s *Server) handleAdminBatchDeleteUsers(w http.ResponseWriter, r *http.Request, c *caller) {
	var req struct {
		Users                 []userRef `json:"users"`
		TransferCredentialsTo *userRef  `json:"transfer_credentials_to"`
		DryRun                bool      `json:"dry_run"`
	}
	if !readJSON(w, r, &req) || !checkBatchSize(w, "users", len(req.Users), maxBatchUsers) {
		return
	}
	var recipient *store.UserKey
	if req.TransferCredentialsTo != nil {
		recipient = &req.TransferCredentialsTo.Key
	}
	deleted, err := s.opts.Store.DeleteUsers(r.Context(), c.actor(), userKeys(req.Users), recipient, req.DryRun, s.opts.Now())
	if err != nil {
		s.writeStoreError(w, err, userNotFound)
		return
	}
	type result struct {
		User                   userBriefView `json:"user"`
		CredentialsDeleted     int           `json:"credentials_deleted"`
		CredentialsTransferred int           `json:"credentials_transferred"`
	}
	results := make([]result, len(deleted))
	for i, d := range deleted {
		results[i] = result{User: newUserBriefView(d.User), CredentialsDeleted: d.Deleted, CredentialsTransferred: d.Transferred}
	}
	writeJSON(w, http.StatusOK, map[string]any{"dry_run": req.DryRun, "results": results})
}
