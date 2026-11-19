package api

import (
	"errors"
	"net/http"

	"github.com/riba2534/passkey-box/server/internal/store"
)

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// validUsername checks the username rule from docs/API.md.
func validUsername(w http.ResponseWriter, username string) bool {
	if _, _, ok := store.NormalizeUsername(username); !ok {
		badRequest(w, "username must be 1-64 characters")
		return false
	}
	return true
}

// validPassword checks the password rule from docs/API.md.
func validPassword(w http.ResponseWriter, password string) bool {
	if password == "" {
		badRequest(w, "password must not be empty")
		return false
	}
	return true
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req loginRequest
	if err := decodeJSON(r, &req); err != nil {
		badRequest(w, "invalid JSON body")
		return
	}
	if !validUsername(w, req.Username) || !validPassword(w, req.Password) {
		return
	}
	user, err := s.opts.Store.Authenticate(r.Context(), req.Username, req.Password)
	if errors.Is(err, store.ErrBadPassword) {
		writeError(w, http.StatusUnauthorized, "unauthorized", "invalid username or password")
		return
	}
	if err != nil {
		s.internalError(w, err)
		return
	}
	if err := s.startSession(w, r, user); err != nil {
		s.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": newUserView(user)})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil && c.Value != "" {
		if err := s.opts.Store.DeleteSession(r.Context(), c.Value); err != nil {
			s.internalError(w, err)
			return
		}
	}
	s.clearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if !s.opts.AllowRegister {
		writeError(w, http.StatusForbidden, "registration_disabled", "self-registration is disabled")
		return
	}
	var req loginRequest
	if err := decodeJSON(r, &req); err != nil {
		badRequest(w, "invalid JSON body")
		return
	}
	if !validUsername(w, req.Username) || !validPassword(w, req.Password) {
		return
	}
	user, err := s.opts.Store.CreateUser(r.Context(), req.Username, req.Password, false, s.opts.Now())
	if errors.Is(err, store.ErrConflict) {
		writeError(w, http.StatusConflict, "conflict", "username already exists")
		return
	}
	if err != nil {
		s.internalError(w, err)
		return
	}
	if err := s.startSession(w, r, user); err != nil {
		s.internalError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"user": newUserView(user)})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request, user store.User) {
	writeJSON(w, http.StatusOK, map[string]any{"user": newUserView(user)})
}

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request, user store.User) {
	var req struct {
		OldPassword string `json:"old_password"`
		NewPassword string `json:"new_password"`
	}
	if err := decodeJSON(r, &req); err != nil {
		badRequest(w, "invalid JSON body")
		return
	}
	if !validPassword(w, req.NewPassword) {
		return
	}
	err := s.opts.Store.CheckPassword(r.Context(), user.ID, req.OldPassword)
	if errors.Is(err, store.ErrBadPassword) {
		writeError(w, http.StatusBadRequest, "invalid_password", "old password is incorrect")
		return
	}
	if err != nil {
		s.internalError(w, err)
		return
	}
	if err := s.opts.Store.SetPassword(r.Context(), user.ID, req.NewPassword); err != nil {
		s.internalError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
