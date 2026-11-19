package api

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/riba2534/passkey-box/server/internal/store"
)

func userNotFound(w http.ResponseWriter) {
	writeError(w, http.StatusNotFound, "not_found", "user not found")
}

// targetUser loads the user named by the {user_id} path value. It writes the
// error response and returns false when the user cannot be loaded.
func (s *Server) targetUser(w http.ResponseWriter, r *http.Request) (store.User, bool) {
	id, err := strconv.ParseInt(r.PathValue("user_id"), 10, 64)
	if err != nil {
		userNotFound(w)
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

func (s *Server) handleAdminListUsers(w http.ResponseWriter, r *http.Request, _ store.User) {
	users, err := s.opts.Store.ListUsers(r.Context())
	if err != nil {
		s.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": newUserViews(users)})
}

func (s *Server) handleAdminCreateUser(w http.ResponseWriter, r *http.Request, _ store.User) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		IsAdmin  bool   `json:"is_admin"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	user, ok := s.createUser(w, r, req.Username, req.Password, req.IsAdmin)
	if !ok {
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"user": newUserView(user)})
}

func (s *Server) handleAdminUpdateUser(w http.ResponseWriter, r *http.Request, me store.User) {
	var req struct {
		Password *string `json:"password"`
		IsAdmin  *bool   `json:"is_admin"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	target, ok := s.targetUser(w, r)
	if !ok {
		return
	}
	if req.Password != nil && !validPassword(w, *req.Password) {
		return
	}
	if req.IsAdmin != nil && !*req.IsAdmin && target.ID == me.ID {
		badRequest(w, "you cannot remove your own administrator role")
		return
	}
	ctx := r.Context()
	if req.Password != nil {
		if err := s.opts.Store.SetPassword(ctx, target.ID, *req.Password); err != nil {
			s.internalError(w, err)
			return
		}
	}
	if req.IsAdmin != nil {
		if err := s.opts.Store.SetAdmin(ctx, target.ID, *req.IsAdmin); err != nil {
			s.internalError(w, err)
			return
		}
	}
	user, err := s.opts.Store.GetUser(ctx, target.ID)
	if err != nil {
		s.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": newUserView(user)})
}

func (s *Server) handleAdminDeleteUser(w http.ResponseWriter, r *http.Request, me store.User) {
	target, ok := s.targetUser(w, r)
	if !ok {
		return
	}
	if target.ID == me.ID {
		badRequest(w, "you cannot delete yourself")
		return
	}
	err := s.opts.Store.DeleteUser(r.Context(), target.ID)
	s.writeNoContent(w, err, userNotFound)
}

func (s *Server) handleAdminListCredentials(w http.ResponseWriter, r *http.Request, _ store.User) {
	target, ok := s.targetUser(w, r)
	if !ok {
		return
	}
	s.writeCredentials(w, r, target.ID)
}

func (s *Server) handleAdminDeleteCredential(w http.ResponseWriter, r *http.Request, _ store.User) {
	target, ok := s.targetUser(w, r)
	if !ok {
		return
	}
	err := s.opts.Store.DeleteCredential(r.Context(), target.ID, r.PathValue("id"))
	s.writeNoContent(w, err, credentialNotFound)
}
