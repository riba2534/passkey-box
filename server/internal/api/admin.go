package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/riba2534/passkey-box/server/internal/store"
)

func userNotFound(w http.ResponseWriter) {
	writeError(w, http.StatusNotFound, "not_found", "user not found")
}

// pathUserID parses the {user_id} path value. It answers 404 and returns
// false when it is not a number; the store reports IDs of no user.
func pathUserID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("user_id"), 10, 64)
	if err != nil {
		userNotFound(w)
		return 0, false
	}
	return id, true
}

// targetUser loads the user named by the {user_id} path value. It writes the
// error response and returns false when the user cannot be loaded.
func (s *Server) targetUser(w http.ResponseWriter, r *http.Request) (store.User, bool) {
	id, ok := pathUserID(w, r)
	if !ok {
		return store.User{}, false
	}
	user, err := s.opts.Store.GetUser(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		userNotFound(w)
		return store.User{}, false
	}
	if err != nil {
		s.internalError(w, err)
		return store.User{}, false
	}
	return user, true
}

func (s *Server) handleAdminListUsers(w http.ResponseWriter, r *http.Request, _ *caller) {
	q := r.URL.Query()
	f := store.UserFilter{Query: strings.TrimSpace(q.Get("q"))}
	switch q.Get("role") {
	case "":
	case "admin":
		f.Admin = new(true)
	case "user":
		f.Admin = new(false)
	default:
		badRequest(w, "role must be admin or user")
		return
	}
	switch q.Get("status") {
	case "":
	case "active":
		f.Disabled = new(false)
	case "disabled":
		f.Disabled = new(true)
	default:
		badRequest(w, "status must be active or disabled")
		return
	}
	users, err := s.opts.Store.ListUsers(r.Context(), f)
	if err != nil {
		s.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": newAdminUserViews(users)})
}

func (s *Server) handleAdminCreateUser(w http.ResponseWriter, r *http.Request, c *caller) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		IsAdmin  bool   `json:"is_admin"`
		Note     string `json:"note"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	user, ok := s.createUser(w, r, c.actor(), store.NewUser{Username: req.Username, Password: req.Password, IsAdmin: req.IsAdmin, Note: req.Note})
	if !ok {
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"user": newAdminUserView(user)})
}

func (s *Server) handleAdminGetUser(w http.ResponseWriter, r *http.Request, _ *caller) {
	user, ok := s.targetUser(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": newAdminUserView(user)})
}

// userUpdateRequest holds the user fields PATCH and batch-update may change.
type userUpdateRequest struct {
	Username *string `json:"username"`
	Password *string `json:"password"`
	IsAdmin  *bool   `json:"is_admin"`
	Disabled *bool   `json:"disabled"`
	Note     *string `json:"note"`
}

func (s *Server) handleAdminUpdateUser(w http.ResponseWriter, r *http.Request, c *caller) {
	var req userUpdateRequest
	if !readJSON(w, r, &req) {
		return
	}
	id, ok := pathUserID(w, r)
	if !ok {
		return
	}
	res, err := s.opts.Store.UpdateUser(r.Context(), c.actor(), id, store.UserUpdate(req), s.opts.Now())
	if err != nil {
		s.writeStoreError(w, err, userNotFound)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": newAdminUserView(res.User)})
}

func (s *Server) handleAdminDeleteUser(w http.ResponseWriter, r *http.Request, c *caller) {
	id, ok := pathUserID(w, r)
	if !ok {
		return
	}
	s.writeNoContent(w, s.opts.Store.DeleteUser(r.Context(), c.actor(), id, s.opts.Now()), userNotFound)
}

func (s *Server) handleAdminRevokeSessions(w http.ResponseWriter, r *http.Request, c *caller) {
	id, ok := pathUserID(w, r)
	if !ok {
		return
	}
	sessions, tokens, err := s.opts.Store.RevokeAccess(r.Context(), c.actor(), id, s.opts.Now())
	if err != nil {
		s.writeStoreError(w, err, userNotFound)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"sessions": sessions, "tokens": tokens})
}
